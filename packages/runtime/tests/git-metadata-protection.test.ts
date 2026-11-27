import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { gitMetadataPaths } from "../src/permissions/git-metadata";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import {
	fixedBash,
	MacSeatbeltBackend,
	type ProtectedShellBackend,
	type ShellProtection,
	supportsProtectedShell,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { createWorkspaceFiles } from "../src/subagents/workspace-files";
import { createApplyPatchTool } from "../src/tools/apply-patch";
import { hashUtf8Content } from "../src/tools/content-hash";
import { createEditTool } from "../src/tools/edit";
import { createReadTool } from "../src/tools/read";
import { createWriteTool } from "../src/tools/write";

const darwinLive =
	process.platform === "darwin" &&
	process.env.CODELIA_TEST_APPROVAL_MAC_LIVE === "1";

async function withGitFixture<T>(
	run: (fixture: {
		root: string;
		main: string;
		linked: string;
		common: string;
		gitdir: string;
		secret: string;
	}) => Promise<T>,
) {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-git-protection-")),
	);
	try {
		const main = path.join(root, "main");
		const linked = path.join(root, "linked");
		mkdirSync(main);
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: main,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: path.join(root, "unused-config"),
					GIT_TERMINAL_PROMPT: "0",
				},
				encoding: "utf8",
			});
		git("init", "-q");
		writeFileSync(path.join(main, "document.txt"), "initial line\n");
		git("add", "document.txt");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"Initial",
		);
		git("config", "fixture.label", "visible-repo-config");
		git("worktree", "add", "--detach", "-q", linked);
		for (const tree of [main, linked])
			writeFileSync(path.join(tree, "document.txt"), "changed line\n");
		const common = path.join(main, ".git");
		const gitdir = realpathSync(path.join(common, "worktrees", "linked"));
		const secret = path.join(common, "private-test-fixture");
		writeFileSync(secret, "private-fixture");
		return await run({ root, main, linked, common, gitdir, secret });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test.skipIf(process.platform === "win32")(
	"the linked worktree marker, gitdir and commondir are resolved independently of private paths",
	() =>
		withGitFixture(async ({ root, main, linked, common, gitdir, secret }) => {
			expect(gitMetadataPaths(main).readOnlyPaths).toEqual([common]);
			expect(gitMetadataPaths(linked).readOnlyPaths).toEqual(
				[
					path.join(linked, ".git"),
					common,
					gitdir,
					path.join(gitdir, "commondir"),
				].sort(),
			);
			const subdirectory = path.join(linked, "subdir");
			mkdirSync(subdirectory);
			expect(gitMetadataPaths(subdirectory).readOnlyPaths).toEqual(
				gitMetadataPaths(linked).readOnlyPaths,
			);
			const policy: ShellProtection = {
				root,
				cwd: linked,
				profile: "development",
				stdin: "closed",
				writeRoots: [root],
				...workspacePathProtection(root, [secret], [linked]),
			};
			expect(policy.protectedPaths).toContain(secret);
			expect(policy.protectedPaths).not.toContain(common);
			const oldAdapter: ProtectedShellBackend = {
				supports: () => true,
				launch: () => {
					throw new Error("Launch must remain unreachable");
				},
			};
			expect(supportsProtectedShell(oldAdapter, policy)).toBe(false);
			expect(
				supportsProtectedShell(oldAdapter, {
					...policy,
					profile: "full-access",
				}),
			).toBe(true);
			expect(
				supportsProtectedShell(oldAdapter, { ...policy, readOnlyPaths: [] }),
			).toBe(true);
			expect(
				supportsProtectedShell(
					{ ...oldAdapter, supportsReadOnlyPaths: true },
					policy,
				),
			).toBe(true);
		}),
);

test.skipIf(process.platform === "win32")(
	"file reads are available and primary and delegated file mutations reject metadata and aliases",
	() =>
		withGitFixture(async ({ root, main, linked, common, gitdir, secret }) => {
			const commonAlias = path.join(root, "common-alias");
			const hardAlias = path.join(linked, "linked-config");
			symlinkSync(common, commonAlias);
			linkSync(path.join(common, "config"), hardAlias);
			for (const [tree, operands] of [
				[main, [".git/config", ".git/missing"]],
				[
					linked,
					[
						".git",
						"linked-config",
						path.join(gitdir, "HEAD"),
						path.join(common, "config"),
					],
				],
				[
					root,
					["common-alias/config", "linked/.git", path.join(gitdir, "HEAD")],
				],
			] as const) {
				const sandbox = await SandboxContext.create(tree, {
					protectResources: true,
					extraProtectedPaths: [secret],
				});
				const ordinary = path.join(tree, "ordinary.txt");
				writeFileSync(ordinary, "ordinary");
				expect(sandbox.selectFile(ordinary, "write").identity).not.toBeNull();
				for (const operand of operands)
					expect(() => sandbox.selectFile(operand, "write")).toThrow();
				if (tree === main) {
					expect(
						(await sandbox.readSelectedFile(".git/config")).toString(),
					).toContain("visible-repo-config");
				}
				if (tree === linked) {
					expect((await sandbox.readSelectedFile(".git")).toString()).toContain(
						"gitdir: ",
					);
				}
			}
			const builtinContext = await SandboxContext.create(main, {
				protectResources: true,
			});
			await expect(
				builtinContext.withSelectedFile(
					".git/config",
					"read",
					"update",
					async () => {},
				),
			).rejects.toThrow("write binding");
			const key = createSandboxKey(builtinContext);
			const read = await createReadTool(key).executeRaw(
				'{"file_path":".git/config"}',
				createToolContext(),
			);
			expect(JSON.stringify(read)).toContain("visible-repo-config");
			await expect(
				createWriteTool(key).executeRaw(
					'{"file_path":".git/config","content":"blocked"}',
					createToolContext(),
				),
			).rejects.toThrow("read-only");

			const sandbox = await SandboxContext.create(linked, {
				protectResources: true,
				extraProtectedPaths: [secret],
			});
			expect((await sandbox.readSelectedFile(hardAlias)).toString()).toContain(
				"visible-repo-config",
			);
			expect(() => sandbox.selectFile(secret, "read")).toThrow("protected");

			const alternateCase = path.join(main, ".GIT", "config");
			if (existsSync(alternateCase)) {
				const mainSandbox = await SandboxContext.create(main, {
					protectResources: true,
				});
				expect(() => mainSandbox.selectFile(alternateCase, "write")).toThrow(
					"read-only",
				);
			}
			const linkedFiles = createWorkspaceFiles(linked);
			const contents = readFileSync(path.join(linked, ".git"), "utf8");
			await expect(
				linkedFiles.update(".git", hashUtf8Content(contents), () => "unused"),
			).rejects.toThrow("read-only");
			const mainFiles = createWorkspaceFiles(main);
			await expect(
				mainFiles.update(".git/new-file", "missing", () => "unused"),
			).rejects.toThrow("read-only");
		}),
);

test.skipIf(process.platform === "win32")(
	"project configuration is readable after host creation and reserved against primary and delegated mutations",
	() =>
		withGitFixture(async ({ root, main }) => {
			const directory = path.join(main, ".codelia");
			const projectConfig = path.join(directory, "config.json");
			const privateFile = path.join(directory, "private-fixture");
			const sandbox = await SandboxContext.create(main, {
				sandboxMode: "workspace-write",
				protectResources: true,
				extraProtectedPaths: [privateFile],
			});
			const key = createSandboxKey(sandbox);
			const call = (tool: ReturnType<typeof createReadTool>, input: object) =>
				tool.executeRaw(JSON.stringify(input), createToolContext());
			const files = createWorkspaceFiles(main, [privateFile]);
			await expect(
				call(createWriteTool(key), {
					file_path: projectConfig,
					content: "blocked",
				}),
			).rejects.toThrow("read-only");
			await expect(
				files.update(".codelia/config.json", "missing", () => "blocked"),
			).rejects.toThrow("read-only");
			expect(existsSync(directory)).toBe(false);
			if (existsSync(path.join(main, "DOCUMENT.TXT")))
				expect(() =>
					sandbox.selectFile(".CODELIA/config.json", "write"),
				).toThrow("read-only");

			const visible = '{"version":1,"label":"project fixture"}\n';
			mkdirSync(directory);
			writeFileSync(projectConfig, visible);
			writeFileSync(privateFile, "fixture-private");
			expect(
				JSON.stringify(
					await call(createReadTool(key), { file_path: projectConfig }),
				),
			).toContain("project fixture");
			expect(
				await files.read(".codelia/config.json", sandbox, () => true),
			).toBe(visible);
			await expect(
				files.read(".codelia/private-fixture", sandbox, () => true),
			).rejects.toThrow("protected");
			await expect(
				call(createEditTool(key), {
					file_path: projectConfig,
					old_string: "project fixture",
					new_string: "blocked",
					expected_hash: hashUtf8Content(visible),
				}),
			).rejects.toThrow("read-only");
			await expect(
				call(createApplyPatchTool(key), {
					patch:
						"*** Begin Patch\n*** Update File: document.txt\n*** Move to: .codelia/moved.txt\n@@\n-changed line\n+moved\n*** End Patch",
				}),
			).rejects.toThrow("read-only");
			const hardAlias = path.join(main, "config-hardlink");
			linkSync(projectConfig, hardAlias);
			expect((await sandbox.readSelectedFile(hardAlias)).toString()).toBe(
				visible,
			);
			expect(() => sandbox.selectFile(hardAlias, "write")).toThrow("read-only");
			const symbolicTarget = path.join(main, "symbolic-target");
			writeFileSync(symbolicTarget, "visible alias");
			symlinkSync(symbolicTarget, path.join(directory, "symbolic-link"));
			expect(() => sandbox.selectFile(symbolicTarget, "write")).toThrow(
				"read-only",
			);
			const linkedRoot = path.join(root, "root-alias");
			mkdirSync(linkedRoot);
			symlinkSync(directory, path.join(linkedRoot, ".codelia"));
			const overlap = await SandboxContext.create(linkedRoot, {
				protectResources: true,
				extraProtectedPaths: [directory],
			});
			await expect(
				overlap.readSelectedFile(".codelia/config.json"),
			).rejects.toThrow("protected");
			expect(readFileSync(projectConfig, "utf8")).toBe(visible);
		}),
);

test.skipIf(!darwinLive)(
	"Seatbelt reserves the project configuration directory and keeps host-created content read-only",
	() =>
		withGitFixture(async ({ root, main }) => {
			const backend = new MacSeatbeltBackend();
			const directory = path.join(main, ".codelia");
			const privateFile = path.join(root, "private-fixture");
			writeFileSync(privateFile, "private contents");
			const run = async (source: string) => {
				const child = backend.launch(fixedBash(source), {
					root: main,
					cwd: main,
					profile: "development",
					stdin: "closed",
					writeRoots: [root],
					...workspacePathProtection(main, [privateFile]),
				});
				child.stderr.resume();
				const [[code], output] = await Promise.all([
					once(child, "close"),
					Array.fromAsync(child.stdout),
				]);
				return { code, text: Buffer.concat(output).toString() };
			};
			expect((await run("mkdir .codelia")).code).not.toBe(0);
			if (existsSync(path.join(main, "DOCUMENT.TXT")))
				expect((await run("mkdir .CODELIA")).code).not.toBe(0);
			expect(existsSync(directory)).toBe(false);
			mkdirSync(directory);
			writeFileSync(
				path.join(directory, "config.json"),
				"visible project config\n",
			);
			symlinkSync(privateFile, path.join(directory, "private-link"));
			const aliasTarget = path.join(main, "config-alias-target");
			writeFileSync(aliasTarget, "visible alias\n");
			symlinkSync(aliasTarget, path.join(directory, "alias"));
			expect(await run("cat .codelia/config.json .codelia/alias")).toEqual({
				code: 0,
				text: "visible project config\nvisible alias\n",
			});
			for (const source of [
				"printf blocked > .codelia/config.json",
				"mv .codelia .codelia-old",
				"mv ../main ../moved",
				"printf blocked > config-alias-target",
				"cat .codelia/private-link",
			])
				expect((await run(source)).code).not.toBe(0);
			expect(readFileSync(path.join(directory, "config.json"), "utf8")).toBe(
				"visible project config\n",
			);
		}),
);

test.skipIf(process.platform === "win32")(
	"ordinary session storage is readable by default and remains write-protected",
	() =>
		withGitFixture(async ({ main }) => {
			const layout = process.env.CODELIA_LAYOUT;
			const state = process.env.XDG_STATE_HOME;
			process.env.CODELIA_LAYOUT = "xdg";
			process.env.XDG_STATE_HOME = path.join(main, "fixture-state");
			try {
				const storage = resolveStoragePaths();
				const history = path.join(storage.sessionsDir, "original.txt");
				mkdirSync(storage.sessionsDir, { recursive: true });
				writeFileSync(history, "session history fixture");
				const sandbox = await SandboxContext.create(main, {
					protectResources: true,
					sandboxMode: "full-access",
				});
				expect((await sandbox.readSelectedFile(history)).toString()).toBe(
					"session history fixture",
				);
				expect(() => sandbox.selectFile(history, "write")).toThrow("read-only");
				expect(workspacePathProtection(main).readOnlyPaths).toContain(
					storage.root,
				);
				expect(workspacePathProtection(main).readOnlyAliasPaths).not.toContain(
					storage.root,
				);
			} finally {
				if (layout === undefined) delete process.env.CODELIA_LAYOUT;
				else process.env.CODELIA_LAYOUT = layout;
				if (state === undefined) delete process.env.XDG_STATE_HOME;
				else process.env.XDG_STATE_HOME = state;
			}
		}),
);

test.skipIf(!darwinLive)(
	"Seatbelt allows status, diff and repository config in normal and linked worktrees while metadata is read-only",
	() =>
		withGitFixture(async ({ root, main, linked, common, gitdir, secret }) => {
			const backend = new MacSeatbeltBackend();
			const commonAlias = path.join(root, "common-alias");
			const privateAlias = path.join(root, "private-alias");
			symlinkSync(common, commonAlias);
			symlinkSync(secret, privateAlias);
			const config = path.join(common, "config");
			const originalConfig = readFileSync(config, "utf8");
			const originalLinkedMarker = readFileSync(
				path.join(linked, ".git"),
				"utf8",
			);
			const capture = async (
				child: ReturnType<ProtectedShellBackend["launch"]>,
			) => {
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr.on("data", (chunk) => {
					stderr += chunk.toString();
				});
				const [code] = await once(child, "close");
				return { code, stdout, stderr };
			};
			const shell = (source: string, protection: ShellProtection) =>
				capture(backend.launch(fixedBash(source), protection));
			const protection = (cwd: string): ShellProtection => ({
				root,
				cwd,
				profile: "development",
				stdin: "closed",
				writeRoots: [root],
				...workspacePathProtection(root, [secret], [cwd]),
			});
			for (const cwd of [main, linked]) {
				const state = new RuntimeState();
				state.runtimeSandboxRoot = cwd;
				state.setRuntimeEnvironment({
					adapters: {
						approvalProtectedPaths: [secret],
						approvalService: {
							confirm: async ({ requestId }) => ({
								requestId,
								choice: "allow_once",
							}),
						},
					},
				});
				const result = await authorizeRuntimeShell(state)(
					{
						cwd,
						origin: "ui_bang",
						source:
							"set -e; git status --short; git diff --no-ext-diff; git config --local --get fixture.label",
					},
					(launch) => capture(launch()),
				);
				expect(result).toMatchObject({ code: 0 });
				expect(result.stdout).toContain(" M document.txt");
				expect(result.stdout).toContain("+changed line");
				expect(result.stdout).toContain("visible-repo-config");
			}
			const quote = (name: string) => `'${name.replaceAll("'", "'\\''")}'`;
			const attempt = (source: string) => `if ${source}; then exit 99; fi`;
			const writes = await shell(
				[
					"set -e",
					"printf yes > ordinary-write",
					`cat ${quote(config)}`,
					attempt(`printf blocked > ${quote(config)}`),
					attempt("printf blocked > .git"),
					attempt(`printf blocked > ${quote(path.join(gitdir, "HEAD"))}`),
					attempt(`printf blocked > ${quote(path.join(gitdir, "new-file"))}`),
					attempt(
						`printf blocked > ${quote(path.join(commonAlias, "config"))}`,
					),
					attempt(`mv ${quote(main)} ${quote(path.join(root, "relocated"))}`),
					attempt(
						"ln " +
							quote(config) +
							" " +
							quote(path.join(root, "new-hardlink")),
					),
					attempt(`cat ${quote(privateAlias)}`),
				].join("\n"),
				protection(linked),
			);
			expect(writes).toMatchObject({ code: 0 });
			expect(writes.stdout).toContain("visible-repo-config");
			expect(writes.stdout).not.toContain("private-fixture");
			expect(readFileSync(config, "utf8")).toBe(originalConfig);
			expect(readFileSync(path.join(linked, ".git"), "utf8")).toBe(
				originalLinkedMarker,
			);
			expect(existsSync(path.join(root, "new-hardlink"))).toBe(false);
			expect(existsSync(path.join(linked, "ordinary-write"))).toBe(true);
			expect(existsSync(path.join(root, "relocated"))).toBe(false);

			const alias = path.join(root, "existing-hardlink");
			linkSync(config, alias);
			expect(backend.supports(protection(linked))).toBe(false);
			const state = new RuntimeState();
			state.runtimeSandboxRoot = linked;
			state.setRuntimeEnvironment({
				adapters: {
					approvalService: {
						confirm: async ({ requestId, route }) => {
							expect(route.profile).toBe("investigation");
							return { requestId, choice: "allow_once" };
						},
					},
				},
			});
			const readThroughRuntime = await authorizeRuntimeShell(state)(
				{
					origin: "parent_agent",
					cwd: linked,
					source: "git status --short; git diff --no-ext-diff",
				},
				(launch) => capture(launch()),
			);
			expect(readThroughRuntime).toMatchObject({ code: 0 });
			expect(readThroughRuntime.stdout).toContain("+changed line");
			const investigation = {
				...protection(linked),
				profile: "investigation",
				writeRoots: [],
			} as const;
			const read = await shell(
				[
					"set -e",
					"git status --short",
					`cat ${quote(alias)}`,
					attempt(`ln ${quote(config)} "$TMPDIR/metadata-link"`),
				].join("\n"),
				investigation,
			);
			expect(read).toMatchObject({ code: 0 });
			expect(read.stdout).toContain("visible-repo-config");
			expect(readFileSync(config, "utf8")).toBe(originalConfig);
		}),
);

test.skipIf(process.platform === "win32")(
	"changing the linked worktree's Git pointer during approval expires the shell request",
	() =>
		withGitFixture(async ({ linked, common }) => {
			let launched = 0;
			const state = new RuntimeState();
			state.runtimeSandboxRoot = linked;
			state.setRuntimeEnvironment({
				adapters: {
					shellProtectionBackend: {
						supports: () => true,
						supportsReadOnlyPaths: true,
						launch: () => {
							launched++;
							throw new Error("Launch must remain unreachable");
						},
					},
					approvalService: {
						confirm: async ({ requestId }) => {
							writeFileSync(path.join(linked, ".git"), `gitdir: ${common}\n`);
							return { requestId, choice: "allow_once" };
						},
					},
				},
			});
			await expect(
				authorizeRuntimeShell(state)(
					{
						cwd: linked,
						origin: "parent_agent",
						source: "git status --short",
					},
					(launch) => launch(),
				),
			).rejects.toThrow("approval_expired");
			expect(launched).toBe(0);
		}),
);
