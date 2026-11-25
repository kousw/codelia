import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { LinuxRunscBackend } from "../src/permissions/linux-shell-backend";
import { requireLocalShellEvidence } from "../src/permissions/review-evidence";
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	absentProtectedSeatbeltAncestors,
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	type ShellProtection,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { approveFixture, fixtureShellAuthority } from "./fixtures/approval";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
		.toString()
		.trim();

const initRepository = (directory: string) => {
	git(directory, "init", "-q");
	git(directory, "config", "user.name", "Fixture");
	git(directory, "config", "user.email", "fixture@example.invalid");
	git(directory, "config", "commit.gpgsign", "false");
	writeFileSync(path.join(directory, "a.txt"), "1\n");
	git(directory, "add", "a.txt");
	git(directory, "commit", "-qm", "initial");
};

let temp: string;

beforeEach(() => {
	// Like the existing Linux live fixture, keep Linux workspaces under HOME.
	const base = process.platform === "linux" ? homedir() : tmpdir();
	temp = realpathSync(mkdtempSync(path.join(base, "codelia-git-scope-")));
});

afterEach(() => {
	rmSync(temp, { recursive: true, force: true });
});

const protectionFor = (
	workspace: string,
	related: readonly string[] = [workspace],
) =>
	workspacePathProtection(
		workspace,
		[],
		related,
		"workspace-write",
		false,
		[],
		{ writeRoots: [workspace], gitWrites: true },
	);

describe("Git write scope", () => {
	test("an ordinary repository opens .git except redirecting and executable entries", () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const protection = protectionFor(temp);
		expect(protection.readOnlyPaths).not.toContain(gitDirectory);
		expect(protection.gitWriteRoots).toBeUndefined();
		for (const name of [
			"config",
			"config.worktree",
			"hooks",
			"commondir",
			"objects/info/alternates",
			"objects/info/http-alternates",
			"remotes",
			"branches",
			"modules",
			"rebase-merge",
			"rebase-apply",
			"sequencer",
		])
			expect(protection.readOnlyPaths).toContain(path.join(gitDirectory, name));
		expect(protection.gitProtectedPaths).toContain(
			path.join(gitDirectory, "commondir"),
		);
		// Built-in file tools keep the whole Git directory read-only.
		expect(workspacePathProtection(temp, [], [temp]).readOnlyPaths).toContain(
			gitDirectory,
		);
	});

	test("opening a subdirectory workspace keeps the parent repository .git read-only", () => {
		initRepository(temp);
		const sub = path.join(temp, "packages", "app");
		mkdirSync(sub, { recursive: true });
		const protection = protectionFor(sub);
		expect(protection.gitWriteRoots).toBeUndefined();
		expect(protection.gitProtectedPaths).toBeUndefined();
		expect(protection.readOnlyPaths).toContain(path.join(temp, ".git"));
	});

	test("protects intermediate symlink hops and fails closed on symlink cycles", () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const realConfig = path.join(temp, "real-config");
		const hop2 = path.join(temp, "hop2");
		const hop1 = path.join(temp, "hop1");
		writeFileSync(realConfig, readFileSync(path.join(gitDirectory, "config")));
		symlinkSync(realConfig, hop2);
		symlinkSync(hop2, hop1);
		rmSync(path.join(gitDirectory, "config"));
		symlinkSync(hop1, path.join(gitDirectory, "config"));

		const realDir = path.join(temp, "real-hook-dir");
		mkdirSync(realDir);
		const dirLink = path.join(temp, "hook-dir-link");
		symlinkSync(realDir, dirLink);
		symlinkSync(
			path.join(dirLink, "pre-commit-target"),
			path.join(gitDirectory, "hooks", "pre-commit"),
		);

		const protection = protectionFor(temp);
		expect(protection.readOnlyPaths).toContain(hop1);
		expect(protection.readOnlyPaths).toContain(hop2);
		expect(protection.readOnlyPaths).toContain(realConfig);
		expect(protection.readOnlyPaths).toContain(dirLink);
		expect(protection.readOnlyPaths).toContain(
			path.join(realDir, "pre-commit-target"),
		);

		// A symlink cycle in a protected Git entry fails closed for the repo.
		const loopA = path.join(temp, "loop-a");
		const loopB = path.join(temp, "loop-b");
		symlinkSync(loopB, loopA);
		symlinkSync(loopA, loopB);
		rmSync(path.join(gitDirectory, "config"));
		symlinkSync(loopA, path.join(gitDirectory, "config"));
		const cyclic = protectionFor(temp);
		expect(cyclic.gitProtectedPaths).toBeUndefined();
		expect(cyclic.readOnlyPaths).toContain(gitDirectory);
	});

	test("protects include.path, includeIf.*.path and core.hooksPath targets and fails closed on malformed config", () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const localConf = path.join(gitDirectory, "local-settings");
		const nestedConf = path.join(gitDirectory, "nested-settings");
		const extraConf = path.join(gitDirectory, "extra.conf");
		const customHooks = path.join(gitDirectory, "custom-hooks");
		const customHookTarget = path.join(temp, "custom-hook-script");
		mkdirSync(customHooks);
		writeFileSync(nestedConf, "[user]\n\tname = Nested\n");
		writeFileSync(localConf, "[include]\n\tpath = nested-settings\n");
		writeFileSync(extraConf, "[user]\n\tname = Extra\n");
		symlinkSync(customHookTarget, path.join(customHooks, "pre-commit"));
		writeFileSync(
			path.join(gitDirectory, "config"),
			[
				readFileSync(path.join(gitDirectory, "config"), "utf8"),
				"[include]",
				"\tpath = local-settings",
				'[includeIf "gitdir:./"]',
				"\tpath = extra.conf",
				"[core]",
				"\thooksPath = .git/custom-hooks",
				"",
			].join("\n"),
		);

		const protection = protectionFor(temp);
		expect(protection.readOnlyPaths).not.toContain(gitDirectory);
		expect(protection.readOnlyPaths).toContain(localConf);
		expect(protection.readOnlyPaths).toContain(nestedConf);
		expect(protection.readOnlyPaths).toContain(extraConf);
		expect(protection.readOnlyPaths).toContain(customHooks);
		expect(protection.readOnlyPaths).toContain(customHookTarget);

		// Malformed include syntax fails closed (whole .git stays read-only).
		writeFileSync(
			path.join(gitDirectory, "config"),
			'[include]\n\tpath = "unterminated\n',
		);
		const malformed = protectionFor(temp);
		expect(malformed.gitProtectedPaths).toBeUndefined();
		expect(malformed.readOnlyPaths).toContain(gitDirectory);
	});

	test("resolves symlinked config relative includes, preserves .. across symlinks, handles trailing-backslash comments, and scans sibling/global configs", () => {
		const main = path.join(temp, "main");
		const externalDir = path.join(temp, "external");
		const linkDir = path.join(temp, "link-dir");
		mkdirSync(main, { recursive: true });
		mkdirSync(path.join(externalDir, "nested"), { recursive: true });
		initRepository(main);
		const commonGit = path.join(main, ".git");

		// 1. Symlinked config: Git resolves relative include.path from the opened
		// symlink directory (.git/), NOT the canonical target directory (external/).
		const realConfig = path.join(externalDir, "real-config");
		const gitDirInclude = path.join(commonGit, "from-opened-dir.conf");
		const symlinkDirTarget = path.join(externalDir, "via-dotdot.conf");
		writeFileSync(gitDirInclude, "[user]\n\tname = Opened\n");
		writeFileSync(symlinkDirTarget, "[user]\n\tname = DotDot\n");
		symlinkSync(path.join(externalDir, "nested"), linkDir);
		writeFileSync(
			realConfig,
			[
				readFileSync(path.join(commonGit, "config"), "utf8"),
				"[user]",
				"\tname = Example # inline comment ending with backslash \\",
				"[include]",
				"\tpath = from-opened-dir.conf",
				"\tpath = ../../link-dir/../via-dotdot.conf",
				"",
			].join("\n"),
		);
		rmSync(path.join(commonGit, "config"));
		symlinkSync(realConfig, path.join(commonGit, "config"));

		// 2. Sibling worktree config.worktree pointing into the shared common dir.
		const wtA = path.join(temp, "wt-a");
		const wtB = path.join(temp, "wt-b");
		git(main, "worktree", "add", "-q", "-b", "wt-a", wtA);
		git(main, "worktree", "add", "-q", "-b", "wt-b", wtB);
		const siblingHookDir = path.join(commonGit, "sibling-hooks");
		mkdirSync(siblingHookDir, { recursive: true });
		writeFileSync(
			path.join(commonGit, "worktrees", "wt-b", "config.worktree"),
			`[core]\n\thooksPath = ${siblingHookDir}\n`,
		);

		// 3. Global config pointing into the shared common dir.
		const globalConfig = path.join(temp, "global.gitconfig");
		const globalIncludedInGit = path.join(commonGit, "global-extra.conf");
		writeFileSync(globalIncludedInGit, "[user]\n\tname = Global\n");
		writeFileSync(globalConfig, `[include]\n\tpath = ${globalIncludedInGit}\n`);
		const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
		const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
		process.env.GIT_CONFIG_GLOBAL = globalConfig;
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		try {
			const protection = protectionFor(wtA);
			expect(protection.readOnlyPaths).toContain(gitDirInclude);
			expect(protection.readOnlyPaths).toContain(symlinkDirTarget);
			expect(protection.readOnlyPaths).toContain(siblingHookDir);
			expect(protection.readOnlyPaths).toContain(globalIncludedInGit);
		} finally {
			if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
			if (prevNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
			else process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem;
		}
	});

	test("createShellAuthorizer defaults allowGitWrites to false so SDK hosts keep .git read-only", async () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const seen: ShellProtection[] = [];
		const stubBackend: ProtectedShellBackend = {
			supportsReadOnlyPaths: true,
			supportsHomeDotProtection: true,
			supportsAbsentPathDenial: true,
			supports: () => true,
			launch: (_inv, protection) => {
				seen.push(protection);
				return { stdout: null, stderr: null } as unknown as ReturnType<
					ProtectedShellBackend["launch"]
				>;
			},
		};
		for (const allowGitWrites of [false, true]) {
			const authorize = createShellAuthorizer({
				root: temp,
				backend: stubBackend,
				allowGitWrites,
				authority: fixtureShellAuthority,
				dispatcher: new ApprovalDispatcher({ confirmation: approveFixture }),
			});
			await authorize(
				{ cwd: temp, origin: "parent_agent", source: "touch out.txt" },
				async (admit) => {
					admit();
				},
			);
		}
		expect(seen[0]?.readOnlyPaths).toContain(gitDirectory);
		expect(seen[0]?.gitProtectedPaths).toBeUndefined();
		expect(seen[1]?.readOnlyPaths).not.toContain(gitDirectory);
		expect(seen[1]?.gitProtectedPaths).toContain(
			path.join(gitDirectory, "config"),
		);
	});

	test("review evidence reports external gitWriteRoots and rejects private overlap", () => {
		const main = path.join(temp, "main");
		mkdirSync(main);
		initRepository(main);
		const worktree = path.join(temp, "wt");
		git(main, "worktree", "add", "-q", "-b", "wt", worktree);
		const common = path.join(main, ".git");
		const request = {
			id: "req-1",
			owner: "session-1",
			origin: "parent_agent" as const,
			subject: "shell",
			registration: "shell",
			authorityVersion: "v1",
			intentVersion: "i1",
			connectionGeneration: "c1",
			input: JSON.stringify({
				invocation: {
					kind: "source",
					dialect: "bash",
					executable: "/bin/bash",
					options: ["--noprofile", "--norc", "-c"],
					source: "git commit -m test",
				},
				protection: {
					profile: "development",
					root: worktree,
					cwd: worktree,
					stdin: "closed",
					writeRoots: [worktree],
					gitWriteRoots: [common],
					protectedPaths: [],
				},
				analysis: {
					opaque: false,
					compound: false,
					operations: [{ argv: ["git", "commit", "-m", "test"] }],
				},
			}),
		};
		const evidence = requireLocalShellEvidence(request, worktree, {
			original: "commit the changes",
			corrections: [],
		});
		expect(evidence.operation.writeScope).toEqual({
			workspaceRelativeRoots: ["."],
			gitWriteRoots: [path.relative(worktree, common)],
			privateScratch: true,
		});
		const privateRequest = {
			...request,
			input: JSON.stringify({
				...JSON.parse(request.input),
				reviewPrivatePaths: [common],
			}),
		};
		expect(() =>
			requireLocalShellEvidence(privateRequest, worktree, {
				original: "commit the changes",
				corrections: [],
			}),
		).toThrow();
	});

	test("a linked worktree opens its metadata and the common directory outside the workspace", () => {
		const main = path.join(temp, "main");
		mkdirSync(main);
		initRepository(main);
		const worktree = path.join(temp, "wt");
		git(main, "worktree", "add", "-q", "-b", "wt", worktree);
		const common = path.join(main, ".git");
		const metadata = path.join(common, "worktrees", "wt");
		const protection = protectionFor(worktree);
		expect(protection.gitWriteRoots).toEqual([common, metadata].sort());
		for (const entry of [
			path.join(worktree, ".git"),
			path.join(metadata, "gitdir"),
			path.join(metadata, "commondir"),
			path.join(metadata, "config.worktree"),
			path.join(common, "config"),
			path.join(common, "hooks"),
		])
			expect(protection.readOnlyPaths).toContain(entry);
		expect(protection.readOnlyPaths).not.toContain(common);
		expect(protection.readOnlyPaths).not.toContain(metadata);
	});

	test("never opens an attacker-controlled nested .git pointer in cwd or an unverified root pointer", () => {
		const victim = path.join(temp, "victim");
		const workspace = path.join(temp, "workspace");
		mkdirSync(victim);
		mkdirSync(workspace);
		initRepository(victim);
		initRepository(workspace);

		// Case 1: nested .pwn/.git pointing directly to an external repository.
		const pwn = path.join(workspace, ".pwn");
		mkdirSync(pwn);
		writeFileSync(
			path.join(pwn, ".git"),
			`gitdir: ${path.join(victim, ".git")}\n`,
		);
		const nestedProtection = protectionFor(workspace, [pwn]);
		expect(nestedProtection.gitWriteRoots).toBeUndefined();
		expect(nestedProtection.readOnlyPaths).toContain(path.join(victim, ".git"));

		// Case 2: nested fake gitdir with commondir pointing to an external dir.
		const target = path.join(temp, "external-with-objects");
		mkdirSync(path.join(target, "objects"), { recursive: true });
		const fakeDir = path.join(pwn, "fg");
		mkdirSync(fakeDir);
		writeFileSync(path.join(fakeDir, "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(path.join(fakeDir, "commondir"), `${target}\n`);
		writeFileSync(path.join(pwn, ".git"), "gitdir: fg\n");
		const commondirProtection = protectionFor(workspace, [pwn]);
		expect(commondirProtection.gitWriteRoots).toBeUndefined();
		expect(commondirProtection.readOnlyPaths).toContain(target);

		// Case 3: unverified .git pointer at workspace root (no worktrees/<name>/gitdir back-pointer).
		const forgedWorkspace = path.join(temp, "forged-root");
		mkdirSync(forgedWorkspace);
		writeFileSync(
			path.join(forgedWorkspace, ".git"),
			`gitdir: ${path.join(victim, ".git")}\n`,
		);
		const forgedProtection = protectionFor(forgedWorkspace);
		expect(forgedProtection.gitWriteRoots).toBeUndefined();
		expect(forgedProtection.readOnlyPaths).toContain(path.join(victim, ".git"));

		// Case 4: symlinked .git directory at workspace root is not opened.
		const symlinkWorkspace = path.join(temp, "symlink-root");
		mkdirSync(symlinkWorkspace);
		symlinkSync(path.join(victim, ".git"), path.join(symlinkWorkspace, ".git"));
		const symlinkProtection = protectionFor(symlinkWorkspace);
		expect(symlinkProtection.gitWriteRoots).toBeUndefined();
		expect(symlinkProtection.readOnlyPaths).toContain(
			path.join(victim, ".git"),
		);
	});

	test("protects symlink targets of Git protected entries and absent objects/info ancestor", () => {
		initRepository(temp);
		const gitDirectory = path.join(temp, ".git");
		const realConfig = path.join(gitDirectory, "real-config");
		writeFileSync(realConfig, readFileSync(path.join(gitDirectory, "config")));
		rmSync(path.join(gitDirectory, "config"));
		symlinkSync(realConfig, path.join(gitDirectory, "config"));

		const realHooks = path.join(gitDirectory, "real-hooks");
		mkdirSync(realHooks);
		const pendingHook = path.join(gitDirectory, "pending-hook");
		symlinkSync(pendingHook, path.join(realHooks, "pre-commit"));
		rmSync(path.join(gitDirectory, "hooks"), { recursive: true, force: true });
		symlinkSync(realHooks, path.join(gitDirectory, "hooks"));

		// Remove objects/info to verify absent ancestor create-protection.
		const objectsInfo = path.join(gitDirectory, "objects", "info");
		rmSync(objectsInfo, { recursive: true, force: true });

		const protection = protectionFor(temp);
		expect(protection.readOnlyPaths).toContain(realConfig);
		expect(protection.readOnlyPaths).toContain(realHooks);
		expect(protection.readOnlyPaths).toContain(pendingHook);

		const absentAncestors = absentProtectedSeatbeltAncestors({
			profile: "development",
			root: temp,
			cwd: temp,
			writeRoots: [temp],
			stdin: "closed",
			...protection,
		});
		expect(absentAncestors).toContain(objectsInfo);
	});

	test("only backends declaring supportsAbsentPathDenial open Git writes; Linux gVisor keeps .git read-only", () => {
		expect(new MacSeatbeltBackend().supportsAbsentPathDenial).toBe(true);
		const linux = new LinuxRunscBackend();
		expect("supportsAbsentPathDenial" in linux).toBe(false);
		initRepository(temp);
		const protection = protectionFor(temp);
		expect(
			linux.supports({
				profile: "development",
				root: temp,
				cwd: temp,
				writeRoots: [temp],
				stdin: "closed",
				...protection,
			}),
		).toBe(false);
	});
});

const liveMac =
	process.platform === "darwin" &&
	process.env.CODELIA_APPROVAL_MAC_LIVE === "1";
const liveLinux =
	process.platform === "linux" &&
	process.env.CODELIA_APPROVAL_LINUX_LIVE === "1";

const runConfined = async (
	backend: ProtectedShellBackend,
	workspace: string,
	source: string,
) => {
	const authorize = createShellAuthorizer({
		root: workspace,
		backend,
		allowGitWrites: true,
		authority: fixtureShellAuthority,
		dispatcher: new ApprovalDispatcher({ confirmation: approveFixture }),
	});
	return authorize(
		{ cwd: workspace, origin: "parent_agent", source },
		async (admit) => {
			const child = admit();
			let output = "";
			child.stdout.on("data", (value) => {
				output += value.toString();
			});
			child.stderr.on("data", (value) => {
				output += value.toString();
			});
			const [code] = await once(child, "close");
			return { code: code as number, output: output.trim() };
		},
	);
};

describe.skipIf(!liveMac)("Seatbelt confined development shell", () => {
	const shell = (workspace: string, source: string) =>
		runConfined(new MacSeatbeltBackend(), workspace, source);

	test("runs ordinary local Git writes and keeps redirecting entries read-only", async () => {
		initRepository(temp);
		writeFileSync(path.join(temp, "b.txt"), "2\n");
		expect(
			await shell(
				temp,
				"git add b.txt && git commit -qm second && git switch -qc feature && git stash list && git rev-list --count HEAD",
			),
		).toEqual({ code: 0, output: "2" });
		const config = readFileSync(path.join(temp, ".git/config"), "utf8");
		for (const source of [
			"echo '[core]' >> .git/config",
			"echo 'exit 0' > .git/hooks/pre-commit",
			"echo /tmp > .git/commondir",
			"echo /tmp > .git/COMMONDIR",
			"mkdir -p .git/objects/info && echo /tmp > .git/objects/info/alternates",
			"mkdir .git/remotes",
			"mkdir -p .git/rebase-merge && echo 'exec id' > .git/rebase-merge/git-rebase-todo",
		])
			await shell(temp, source);
		expect(readFileSync(path.join(temp, ".git/config"), "utf8")).toBe(config);
		for (const name of [
			"hooks/pre-commit",
			"commondir",
			"COMMONDIR",
			"objects/info/alternates",
			"remotes",
			"rebase-merge",
		])
			expect(existsSync(path.join(temp, ".git", name))).toBe(false);
	});

	test("blocks symlinking an absent .git/objects/info directory", async () => {
		initRepository(temp);
		rmSync(path.join(temp, ".git/objects/info"), {
			recursive: true,
			force: true,
		});
		const evil = path.join(temp, "evil-info");
		mkdirSync(evil);
		const result = await shell(temp, `ln -s "${evil}" .git/objects/info`);
		expect(result.code).not.toBe(0);
		expect(existsSync(path.join(temp, ".git/objects/info"))).toBe(false);
	});

	test("commits in a linked worktree whose common directory is outside the workspace", async () => {
		const main = path.join(temp, "main");
		mkdirSync(main);
		initRepository(main);
		const worktree = path.join(temp, "wt");
		git(main, "worktree", "add", "-q", "-b", "wt", worktree);
		writeFileSync(path.join(worktree, "c.txt"), "3\n");
		expect(
			await shell(
				worktree,
				"git add c.txt && git commit -qm linked && git rev-list --count HEAD",
			),
		).toEqual({ code: 0, output: "2" });
		expect(git(main, "rev-list", "--count", "wt")).toBe("2");
	});

	test("uses the login HOME, allocates a sandbox PTY, and blocks reading/writing pre-existing ttys", async () => {
		// Hold a host-side PTY open outside the sandbox so the confined shell
		// must fail with EPERM/EACCES (not ENOENT) when opening it.
		const holder = spawn(
			"python3",
			[
				"-c",
				[
					"import os, pty, sys",
					"m, s = pty.openpty()",
					"print(os.ttyname(s), flush=True)",
					"sys.stdin.read()",
				].join("; "),
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		try {
			const hostPty = await new Promise<string>((resolve, reject) => {
				let buf = "";
				holder.stdout.on("data", (chunk: Buffer) => {
					buf += chunk.toString();
					const nl = buf.indexOf("\n");
					if (nl !== -1) resolve(buf.slice(0, nl).trim());
				});
				holder.once("error", reject);
				holder.once("exit", (code) =>
					reject(new Error(`pty holder exited early (${code})`)),
				);
			});
			const ptyCheck = [
				"import os, sys, errno",
				"p = sys.argv[1]",
				"try:",
				"    os.open(p, os.O_RDWR | os.O_NOCTTY)",
				'    print("UNEXPECTED_OPEN")',
				"except OSError as e:",
				'    print("BLOCKED" if e.errno in (errno.EPERM, errno.EACCES) else f"ERR_{e.errno}")',
			].join("\n");
			const result = await shell(
				temp,
				[
					`printf '%s\\n' "$HOME"`,
					`python3 -c 'import os; m, s = os.openpty(); print(os.isatty(s))'`,
					`python3 -c '${ptyCheck}' "${hostPty}"`,
				].join(" && "),
			);
			expect(result).toEqual({
				code: 0,
				output: `${homedir()}\nTrue\nBLOCKED`,
			});
		} finally {
			holder.stdin.end();
			holder.kill("SIGKILL");
		}
	});
});

describe.skipIf(!liveLinux)("Linux gVisor confined development shell", () => {
	const shell = (workspace: string, source: string) =>
		runConfined(new LinuxRunscBackend(), workspace, source);

	test("uses the login HOME, allows workspace writes, and keeps .git read-only without absent-path denial", async () => {
		initRepository(temp);
		// Rootless Linux gVisor requires existing read-only mountpoints (`.codelia`)
		// inside a writable workspace root, matching command-approval-platform.test.ts.
		mkdirSync(path.join(temp, ".codelia"));
		const result = await shell(temp, `printf '%s' "$HOME"`);
		expect(result).toEqual({ code: 0, output: homedir() });
		const commit = await shell(
			temp,
			"echo hi > b.txt && git add b.txt && git commit -qm blocked",
		);
		expect(commit.code).not.toBe(0);
		expect(readFileSync(path.join(temp, "b.txt"), "utf8")).toBe("hi\n");
		expect(git(temp, "rev-list", "--count", "HEAD")).toBe("1");
		expect(git(temp, "diff", "--cached", "--name-only")).toBe("");
	});
});
