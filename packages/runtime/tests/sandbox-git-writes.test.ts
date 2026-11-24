import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { createShellAuthorizer } from "../src/permissions/shell-approval";
import {
	absentProtectedSeatbeltAncestors,
	MacSeatbeltBackend,
	type ProtectedShellBackend,
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
		])
			await shell(temp, source);
		expect(readFileSync(path.join(temp, ".git/config"), "utf8")).toBe(config);
		for (const name of [
			"hooks/pre-commit",
			"commondir",
			"COMMONDIR",
			"objects/info/alternates",
			"remotes",
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

	test("uses the login HOME and can allocate a pseudo-terminal", async () => {
		const result = await shell(
			temp,
			`printf '%s\\n' "$HOME" && python3 -c 'import os; m, s = os.openpty(); print(os.isatty(s))'`,
		);
		expect(result).toEqual({ code: 0, output: `${homedir()}\nTrue` });
	});
});

describe.skipIf(!liveLinux)("Linux gVisor confined development shell", () => {
	const shell = (workspace: string, source: string) =>
		runConfined(new LinuxRunscBackend(), workspace, source);

	test("uses the login HOME and keeps .git read-only without absent-path denial", async () => {
		initRepository(temp);
		const result = await shell(temp, `printf '%s' "$HOME"`);
		expect(result).toEqual({ code: 0, output: homedir() });
		const commit = await shell(
			temp,
			"echo hi > b.txt && git add b.txt && git commit -qm blocked",
		);
		expect(commit.code).not.toBe(0);
	});
});
