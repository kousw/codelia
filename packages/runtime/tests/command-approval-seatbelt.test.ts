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
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createMacMxcShellBackend,
	fixedBash,
	MacSeatbeltBackend,
	protectedSeatbeltAncestors,
	type ShellProtection,
	workspacePathProtection,
} from "../src/permissions/shell-backend";

test("Seatbelt pins writable ancestors of both kinds of protected resource", () => {
	const root = path.resolve("fixture");
	const nested = path.join(root, "nested");
	const shared = path.join(root, "shared");
	const protectedPaths = [
		path.join(nested, "private.txt"),
		path.resolve("outside", "private.txt"),
	];
	const readOnlyPaths = [path.join(shared, "config.json")];
	expect(
		new Set(
			protectedSeatbeltAncestors({
				root,
				cwd: root,
				stdin: "closed",
				profile: "development",
				writeRoots: [root],
				protectedPaths,
				readOnlyPaths,
			}),
		),
	).toEqual(new Set([root, nested, shared]));
	expect(
		protectedSeatbeltAncestors({
			root,
			cwd: root,
			stdin: "closed",
			profile: "investigation",
			writeRoots: [],
			protectedPaths,
			readOnlyPaths,
		}),
	).toEqual([]);
});

const enabled =
	process.platform === "darwin" &&
	process.env.CODELIA_APPROVAL_MAC_LIVE === "1";

const seatbeltBackends = ["direct"];
if (process.arch === "arm64" && process.env.CODELIA_APPROVAL_MXC_LIVE === "1")
	seatbeltBackends.push("MXC");

test.skipIf(!enabled).each(seatbeltBackends)(
	"Seatbelt (%s) restricts child and descendant filesystem, local communication and environment",
	async (driver) => {
		const temp = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-seatbelt-")),
		);
		const root = path.join(temp, "workspace");
		const adjacent = path.join(temp, "adjacent");
		const secret = path.join(temp, "protected");
		for (const directory of [root, adjacent, secret]) mkdirSync(directory);
		writeFileSync(path.join(adjacent, "data"), "ordinary-file");
		writeFileSync(path.join(secret, "data"), "protected-fixture");
		symlinkSync(adjacent, path.join(root, "alias"));
		symlinkSync(secret, path.join(root, "protected-alias"));
		const tcp = createServer((client) => client.end());
		const socketPath = path.join(temp, "sock");
		const unix = createServer((client) => client.end());
		try {
			tcp.listen(0, "127.0.0.1");
			unix.listen(socketPath);
			await Promise.all([once(tcp, "listening"), once(unix, "listening")]);
			const address = tcp.address();
			if (!address || typeof address === "string")
				throw new Error("missing listener");
			const backend =
				driver === "MXC"
					? createMacMxcShellBackend()
					: new MacSeatbeltBackend();
			const base = {
				profile: "investigation",
				root,
				cwd: root,
				stdin: "closed",
				writeRoots: [],
				protectedPaths: [secret],
			} satisfies ShellProtection;
			expect(backend.supports(base)).toBe(true);
			const launch = async (source: string, protection: ShellProtection) => {
				const child = backend.launch(fixedBash(source), protection);
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (data) => {
					stdout += data.toString();
				});
				child.stderr.on("data", (data) => {
					stderr += data.toString();
				});
				const [code] = await once(child, "close");
				return { code, stdout, stderr };
			};
			const result = await launch(
				[
					"set -e",
					'/bin/bash --noprofile --norc -c "cat alias/data"',
					'printf scratch > "$TMPDIR/okay"',
					'if /bin/bash --noprofile --norc -c "printf no > denied-write"; then exit 41; fi',
					'if /bin/bash --noprofile --norc -c "cat protected-alias/data"; then exit 42; fi',
					`if /usr/bin/nc -G 1 -z 127.0.0.1 ${address.port}; then exit 43; fi`,
					`if /usr/bin/nc -U "${socketPath}" </dev/null; then exit 44; fi`,
					`test -z "\${CODELIA_APPROVAL_MAC_LIVE:-}"`,
					'if /bin/ln alias/data "$TMPDIR/linked"; then printf no > "$TMPDIR/linked"; fi',
				].join("\n"),
				base,
			);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("ordinary-file");
			expect(result.stderr).toContain("Operation not permitted");
			expect(existsSync(path.join(root, "denied-write"))).toBe(false);
			expect(readFileSync(path.join(adjacent, "data"), "utf8")).toBe(
				"ordinary-file",
			);
			const development = {
				...base,
				profile: "development",
				writeRoots: [root],
			} as const;
			linkSync(path.join(adjacent, "data"), path.join(root, "linked"));
			expect(backend.supports(development)).toBe(true);
			const writable = await launch(
				[
					"set -e",
					"printf yes > allowed-write",
					"printf shared-update > linked",
					'if /bin/bash --noprofile --norc -c "printf no > alias/data"; then exit 45; fi',
					"if /bin/ln alias/data new-link; then exit 46; fi",
					'if /bin/bash --noprofile --norc -c "cat protected-alias/data"; then exit 47; fi',
					`if /usr/bin/nc -G 1 -z 127.0.0.1 ${address.port}; then exit 48; fi`,
				].join("\n"),
				development,
			);
			expect(writable.code).toBe(0);
			expect(existsSync(path.join(root, "new-link"))).toBe(false);
			expect(readFileSync(path.join(root, "allowed-write"), "utf8")).toBe(
				"yes",
			);
			expect(readFileSync(path.join(adjacent, "data"), "utf8")).toBe(
				"shared-update",
			);

			linkSync(
				path.join(secret, "data"),
				path.join(root, "protected-hardlink"),
			);
			expect(backend.supports(development)).toBe(false);
			expect(backend.supports(base)).toBe(false);
			expect(() =>
				backend.launch(
					fixedBash("printf no > protected-hardlink"),
					development,
				),
			).toThrow("sandbox_unavailable");
			expect(readFileSync(path.join(secret, "data"), "utf8")).toBe(
				"protected-fixture",
			);
		} finally {
			tcp.close();
			unix.close();
			rmSync(temp, { recursive: true, force: true });
		}
	},
);

test.skipIf(!enabled).each(seatbeltBackends)(
	"Seatbelt (%s) handles a local Git clone and protects fixed parent and delegated writes",
	async (driver) => {
		const temp = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-file-broker-")),
		);
		const origin = path.join(temp, "origin");
		const root = path.join(temp, "workspace");
		const packed = path.join(temp, "packed");
		const packedOrigin = path.join(temp, "packed-origin");
		const linked = path.join(temp, "linked");
		const independent = path.join(temp, "independent");
		const config = path.join(root, "runtime-config.json");
		const env = new Map<string, string | undefined>();
		const setEnv = (name: string, value: string) => {
			env.set(name, process.env[name]);
			process.env[name] = value;
		};
		const git = (cwd: string, ...args: string[]) =>
			execFileSync("/usr/bin/git", args, { cwd, stdio: "pipe" });
		const realFetch = globalThis.fetch;
		const { TaskManager } = await import("../src/tasks");
		const { TaskRegistryStore, resolveStoragePaths } = await import(
			"@codelia/storage"
		);
		const tasks = new TaskManager({
			registry: new TaskRegistryStore(path.join(temp, "tasks")),
		});
		try {
			git(temp, "init", "--quiet", origin);
			writeFileSync(path.join(origin, "tracked.txt"), "ordinary fixture\n");
			writeFileSync(
				path.join(origin, "development.test.ts"),
				'import { test } from "bun:test";\n' +
					'test("ordinary development output", async () => { await Bun.write("build-output.txt", "built\\n"); });\n',
			);
			git(origin, "add", "tracked.txt", "development.test.ts");
			git(
				origin,
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"-m",
				"Fixture",
			);
			git(temp, "clone", "--local", "--quiet", origin, root);
			const hookTarget = path.join(root, "fixture-hook.txt");
			writeFileSync(hookTarget, "ordinary hook target\n");
			symlinkSync(hookTarget, path.join(root, ".git", "hooks", "fixture-hook"));
			const head = git(root, "rev-parse", "HEAD").toString().trim();
			const object = path.join(
				root,
				".git",
				"objects",
				head.slice(0, 2),
				head.slice(2),
			);
			git(
				temp,
				"clone",
				"--local",
				"--no-hardlinks",
				"--quiet",
				origin,
				packedOrigin,
			);
			git(packedOrigin, "gc", "--quiet");
			git(temp, "clone", "--local", "--quiet", packedOrigin, packed);
			expect(statSync(object).nlink).toBeGreaterThan(1);
			git(packed, "worktree", "add", "-b", "fixture-linked", "--quiet", linked);
			git(
				temp,
				"clone",
				"--local",
				"--no-hardlinks",
				"--quiet",
				packedOrigin,
				independent,
			);
			const backend =
				driver === "MXC"
					? createMacMxcShellBackend()
					: new MacSeatbeltBackend();
			setEnv(
				"CODELIA_MAC_SHELL_BACKEND",
				driver === "MXC" ? "mxc" : "seatbelt",
			);
			const supportsShell = (workspace: string) =>
				backend.supports({
					profile: "development",
					root: workspace,
					cwd: workspace,
					stdin: "closed",
					writeRoots: [workspace],
					...workspacePathProtection(workspace, [], []),
				});
			expect(supportsShell(root)).toBe(false);
			expect(supportsShell(independent)).toBe(true);
			for (const key of [
				"XDG_CONFIG_HOME",
				"XDG_CACHE_HOME",
				"XDG_STATE_HOME",
				"XDG_DATA_HOME",
			])
				setEnv(key, path.join(temp, key));
			setEnv("CODELIA_LAYOUT", "xdg");
			setEnv("CODELIA_CONFIG_PATH", config);
			setEnv("CODELIA_SANDBOX_ROOT", root);
			setEnv("OPENAI_API_KEY", "fixture-only");
			const storage = resolveStoragePaths();
			mkdirSync(storage.configDir, { recursive: true });
			writeFileSync(
				storage.projectsFile,
				JSON.stringify({
					version: 1,
					default: {
						protected_paths: [path.join(root, "private-default.txt")],
					},
					projects: {
						[root]: {
							protected_paths: [path.join(root, "private-project.txt")],
						},
					},
				}),
				{ mode: 0o600 },
			);
			const note = path.join(storage.configDir, "ordinary-note.txt");
			writeFileSync(note, "synthetic runtime note\n");
			for (const name of [".agents", ".codelia"]) {
				mkdirSync(path.join(root, name), { recursive: true });
				writeFileSync(
					path.join(root, name, "example.txt"),
					"ordinary fixture\n",
				);
			}
			writeFileSync(
				path.join(root, ".env.local"),
				"synthetic workspace text\n",
			);
			for (const name of ["private-default.txt", "private-project.txt"]) {
				writeFileSync(path.join(root, name), "private fixture\n");
			}
			writeFileSync(
				config,
				JSON.stringify({
					version: 1,
					model: { provider: "openai", name: "gpt-6-astra" },
					skills: { enabled: false },
					execution_environment: { startup_checks: { enabled: false } },
				}),
			);
			globalThis.fetch = Object.assign(
				async (url: Parameters<typeof fetch>[0]) => {
					if (String(url) !== "https://models.dev/api.json")
						throw new Error(
							"Unexpected network request in fixed mutation fixture",
						);
					return Response.json({
						openai: {
							models: {
								"gpt-6-astra": {
									id: "gpt-6-astra",
									name: "Fixture",
									limit: { context: 128000, output: 16384 },
								},
							},
						},
					});
				},
				{ preconnect: realFetch.preconnect },
			);
			const { createAgentFactory } = await import("../src/agent-factory");
			const { RuntimeState } = await import("../src/runtime-state");
			const { authorizeRuntimeShell, runtimeFileMutations } = await import(
				"../src/permissions/runtime-approval"
			);
			const { createToolContext } = await import("../src/rpc/tool");
			const { AgentTreeCoordinator } = await import(
				"../src/subagents/coordinator"
			);
			const { VolatileSessionStateStore } = await import(
				"../src/volatile-stores"
			);
			const shell = (
				workspace: string,
				source: string,
				extraProtectedPaths: readonly string[] = [],
				sandboxMode: "workspace-write" | "full-access" = "workspace-write",
			) => {
				const shellState = new RuntimeState();
				shellState.runtimeWorkingDir = workspace;
				shellState.runtimeSandboxRoot = workspace;
				shellState.setRuntimeEnvironment({
					adapters: {
						approvalProtectedPaths: extraProtectedPaths,
						approvalService: {
							confirm: async ({ requestId }) => ({
								requestId,
								choice: "allow_once",
							}),
						},
					},
				});
				shellState.sandboxMode = { value: sandboxMode, source: "cli" };
				return authorizeRuntimeShell(shellState)(
					{ cwd: workspace, source, origin: "parent_agent" },
					async (admit) => {
						const child = admit();
						let stdout = "";
						let stderr = "";
						child.stdout.on("data", (value) => {
							stdout += value.toString();
						});
						child.stderr.on("data", (value) => {
							stderr += value.toString();
						});
						const [exit] = await once(child, "close");
						if (exit !== 0)
							throw new Error(`Fixture command failed: ${stderr}`);
						return stdout;
					},
				);
			};
			const bunExecutable = `'${process.execPath.replaceAll("'", "'\\''")}'`;
			const developmentCommand = `${bunExecutable} test ./development.test.ts`;
			const cargoHome = path.join(temp, "synthetic cargo home");
			const rustupHome = path.join(temp, "synthetic rustup home");
			mkdirSync(cargoHome);
			mkdirSync(rustupHome);
			setEnv("CARGO_HOME", cargoHome);
			setEnv("RUSTUP_HOME", rustupHome);
			setEnv("CODELIA_FIXTURE_SECRET", "worker-only-check");
			const [home, cargo, rustup, secret] = (
				await shell(
					root,
					'printf \'%s\\n\' "$HOME" "$CARGO_HOME" "$RUSTUP_HOME" "secret=$CODELIA_FIXTURE_SECRET"',
				)
			)
				.trimEnd()
				.split("\n");
			expect(home).toContain("codelia-shell-");
			expect([cargo, rustup, secret]).toEqual([
				cargoHome,
				rustupHome,
				"secret=",
			]);
			await expect(shell(root, "git status --short --branch")).resolves.toMatch(
				/^## /u,
			);
			expect(await shell(root, "cat .env.local")).toBe(
				"synthetic workspace text\n",
			);
			expect(
				await shell(root, "cat .agents/example.txt .codelia/example.txt"),
			).toBe("ordinary fixture\nordinary fixture\n");
			await expect(shell(root, "cat private-default.txt")).rejects.toThrow(
				"Fixture command failed:",
			);
			await expect(shell(root, "cat private-project.txt")).rejects.toThrow(
				"Fixture command failed:",
			);
			expect(await shell(root, "printf full-access", [], "full-access")).toBe(
				"full-access",
			);
			for (const workspace of [root, packed, linked, independent]) {
				await shell(workspace, developmentCommand);
				expect(
					readFileSync(path.join(workspace, "build-output.txt"), "utf8"),
				).toBe("built\n");
			}
			const configPath = path.join(root, ".git", "config");
			const originalConfig = readFileSync(configPath, "utf8");
			await expect(
				shell(root, "git config --local codelia.fixture test"),
			).rejects.toThrow("Fixture command failed:");
			expect(readFileSync(configPath, "utf8")).toBe(originalConfig);

			await expect(shell(root, developmentCommand, [object])).rejects.toThrow(
				"sandbox_unavailable",
			);
			const protections = workspacePathProtection(
				root,
				[],
				[],
				"workspace-write",
				true,
			);
			expect(protections.readOnlyPaths).toEqual(
				expect.arrayContaining([
					path.join(root, ".git"),
					path.join(root, ".codelia"),
				]),
			);
			expect(protections.readOnlyPaths).toContain(hookTarget);
			expect(protections.readOnlyAliasPaths).toContain(
				resolveStoragePaths().authFile,
			);
			expect(protections.protectedPaths).not.toContain(
				resolveStoragePaths().authFile,
			);
			expect(protections.readOnlyAliasPaths).not.toContain(storage.cacheDir);
			expect(protections.readOnlyAliasPaths).not.toContain(storage.sessionsDir);

			const incomplete = path.join(temp, "incomplete");
			mkdirSync(path.join(incomplete, ".git", "objects"), { recursive: true });
			mkdirSync(path.join(incomplete, ".git", "refs"));
			writeFileSync(path.join(incomplete, ".git", "HEAD"), "ordinary text\n");
			expect(
				workspacePathProtection(incomplete, [], [], "workspace-write", true)
					.sharedGitObjectDirectories,
			).toBeUndefined();
			type Channel = import("../src/subagents/contracts").SubagentChannel;
			type TaskExecutionResult = import("../src/tasks").TaskExecutionResult;
			const channels = new Map<string, Channel>();
			const subagents = new AgentTreeCoordinator(tasks, {
				isAvailable: () => true,
				prepare(input, channel) {
					if (!channel) throw new Error("No delegated channel");
					channels.set(input.task_id, channel);
					const wait = Promise.withResolvers<TaskExecutionResult>();
					return {
						wait: wait.promise,
						async start(control) {
							await control.running({ child_session_id: input.task_id });
						},
						async cancel() {
							wait.resolve({
								state: "cancelled",
								result: { termination_reason: "cancelled" },
							});
						},
					};
				},
			});
			const state = new RuntimeState();
			let prompts = 0;
			state.setRuntimeEnvironment({
				adapters: {
					approvalService: {
						confirm: async ({ requestId }) => {
							prompts++;
							return { requestId, choice: "allow_once" };
						},
					},
				},
			});
			state.runtimeWorkingDir = root;
			state.runtimeSandboxRoot = root;
			state.sessionId = state.nextSessionId();
			expect(
				await runtimeFileMutations(state, root, "readonly"),
			).toBeUndefined();
			await createAgentFactory(state, {
				subagents,
				taskManager: tasks,
				sessionStateStore: new VolatileSessionStateStore(),
			})();
			const call = (name: string, args: object) => {
				const tool = state.tools?.find((candidate) => candidate.name === name);
				if (!tool) throw new Error(`No registered ${name} tool`);
				return tool.executeRaw(JSON.stringify(args), createToolContext());
			};
			const fixtureRead = (file_path: string) => call("read", { file_path });
			expect(await fixtureRead(note)).toMatchObject({
				type: "text",
				text: expect.stringContaining("synthetic runtime note"),
			});
			expect(await fixtureRead(".env.local")).toMatchObject({
				type: "text",
				text: expect.stringContaining("synthetic workspace text"),
			});
			await expect(fixtureRead("private-project.txt")).rejects.toThrow(
				"Path is protected",
			);
			await expect(
				call("write", {
					file_path: "private-default.txt",
					content: "ordinary patch",
				}),
			).rejects.toThrow("Path is protected");
			await expect(
				call("write", { file_path: config, content: "ordinary patch" }),
			).rejects.toThrow("Path is read-only");
			expect(
				(
					await call("write", {
						file_path: "nested/inner/a.txt",
						content: "first\n",
					})
				).type,
			).toBe("json");
			expect(readFileSync(path.join(root, "nested/inner/a.txt"), "utf8")).toBe(
				"first\n",
			);
			expect(prompts).toBe(0);
			await call("apply_patch", {
				patch:
					"*** Begin Patch\n*** Add File: b.txt\n+added\n*** Update File: nested/inner/a.txt\n@@\n-first\n+patched\n*** End Patch",
			});
			expect(readFileSync(path.join(root, "b.txt"), "utf8")).toBe("added\n");
			expect(readFileSync(path.join(root, "nested/inner/a.txt"), "utf8")).toBe(
				"patched\n",
			);
			await expect(
				call("apply_patch", {
					patch:
						"*** Begin Patch\n*** Add File: collision.txt\n+file\n*** Add File: collision.txt/child.txt\n+child\n*** End Patch",
				}),
			).rejects.toThrow("Patch targets a file and a path inside it");
			expect(existsSync(path.join(root, "collision.txt"))).toBe(false);
			expect(prompts).toBe(0);
			await call("write", {
				file_path: "nested/inner/a.txt",
				content: "second\n",
			});
			expect(readFileSync(path.join(root, "nested/inner/a.txt"), "utf8")).toBe(
				"second\n",
			);
			await call("apply_patch", {
				patch:
					"*** Begin Patch\n*** Update File: nested/inner/a.txt\n*** Move to: nested/moved.txt\n@@\n-second\n+moved\n*** End Patch",
			});
			expect(existsSync(path.join(root, "nested/inner/a.txt"))).toBe(false);
			expect(readFileSync(path.join(root, "nested/moved.txt"), "utf8")).toBe(
				"moved\n",
			);
			await call("apply_patch", {
				patch:
					"*** Begin Patch\n*** Update File: nested/moved.txt\n@@\n-moved\n+kept\n*** Delete File: b.txt\n*** End Patch",
			});
			expect(existsSync(path.join(root, "b.txt"))).toBe(false);
			expect(readFileSync(path.join(root, "nested/moved.txt"), "utf8")).toBe(
				"kept\n",
			);
			expect(prompts).toBe(2);
			const child = await subagents.spawn(
				{
					kind: "subagent",
					name: "Fixture writer",
					prompt: "Create delegated.txt",
				},
				{ session_id: state.sessionId },
			);
			const delegated = channels.get(child.task_id);
			if (!delegated)
				throw new Error("Fixture child did not receive the parent channel");
			expect(
				await delegated.request("read", { file_path: ".env.local" }),
			).toContain("synthetic workspace text");
			await expect(
				delegated.request("read", { file_path: "private-default.txt" }),
			).rejects.toThrow("Path is protected");
			await expect(
				delegated.request("write", {
					file_path: "private-project.txt",
					content: "ordinary patch",
					expected_hash: "missing",
				}),
			).rejects.toThrow("Path is protected");
			await delegated.request("write", {
				file_path: "child/delegated.txt",
				content: "delegated\n",
				expected_hash: "missing",
			});
			expect(readFileSync(path.join(root, "child/delegated.txt"), "utf8")).toBe(
				"delegated\n",
			);
		} finally {
			globalThis.fetch = realFetch;
			for (const [name, value] of env) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await tasks.shutdown();
			rmSync(temp, { recursive: true, force: true });
		}
	},
	15_000,
);

test.skipIf(!enabled)(
	"protected shell RPC starts the original finite loop once without approval UI",
	async () => {
		const root = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-seatbelt-rpc-")),
		);
		const { RuntimeState } = await import("../src/runtime-state");
		const { runtimeEnvironmentPresets } = await import("../src/environment");
		const { createRuntimeHandlers } = await import("../src/rpc/handlers");
		const { TaskRegistryStore } = await import("@codelia/storage");
		const { TaskManager } = await import("../src/tasks");
		const { VolatileSessionStateStore } = await import(
			"../src/volatile-stores"
		);
		const tasks = new TaskManager({
			registry: new TaskRegistryStore(path.join(root, "tasks")),
		});
		try {
			const source = 'set -e; for f in a.txt b.txt; do wc -l "$f"; done';
			writeFileSync(path.join(root, "a.txt"), "one\n");
			writeFileSync(path.join(root, "b.txt"), "one\ntwo\n");
			const backend = new MacSeatbeltBackend();
			const state = new RuntimeState();
			let launched = 0;
			let confirmations = 0;
			let reviews = 0;
			const taskIds: string[] = [];
			state.setRuntimeEnvironment({
				environment: {
					contract: {
						...runtimeEnvironmentPresets["tui-local"],
						workspace: { root, filesystem: "enabled", process: "runtime" },
						config: { source: "disabled" },
						context: {
							systemPrompt: "runtime-default",
							projectInstructions: "disabled",
							skills: "disabled",
							executionEnvironment: "disabled",
						},
						tools: {
							builtin: "none",
							search: "disabled",
							mcp: "disabled",
							host: "disabled",
						},
					},
				},
				adapters: {
					shellProtectionBackend: {
						supportsReadOnlyPaths: true,
						supportsCommandBinding: backend.supportsCommandBinding,
						supports: (profile) => backend.supports(profile),
						launch: (invocation, profile) => {
							launched++;
							expect(invocation.kind === "source" && invocation.source).toBe(
								source,
							);
							return backend.launch(invocation, profile);
						},
					},
					approvalService: {
						confirm: async () => {
							confirmations++;
							return null;
						},
					},
					approvalReviewer: {
						categories: ["local_test"],
						buildEvidence: async () => "unused",
						review: async () => {
							reviews++;
							return null;
						},
					},
					approvalAudit: (entry) => {
						if (entry.taskId) taskIds.push(entry.taskId);
					},
				},
			});
			state.runtimeWorkingDir = root;
			state.runtimeSandboxRoot = root;
			const { processMessage } = createRuntimeHandlers({
				state,
				getAgent: async () => {
					throw new Error("model must not start");
				},
				log: () => {},
				taskManager: tasks,
				sessionStateStore: new VolatileSessionStateStore(),
			});
			const original = process.stdout.write;
			const reply = await new Promise<Record<string, unknown>>(
				(resolve, reject) => {
					const timer = setTimeout(() => {
						process.stdout.write = original;
						reject(new Error("shell RPC timed out"));
					}, 3000);
					process.stdout.write = ((chunk: string) => {
						for (const line of String(chunk).trim().split("\n")) {
							const decoded = JSON.parse(line) as Record<string, unknown>;
							if (decoded.id === "native-loop") {
								clearTimeout(timer);
								process.stdout.write = original;
								resolve(decoded);
							}
						}
						return true;
					}) as typeof process.stdout.write;
					processMessage({
						jsonrpc: "2.0",
						id: "native-loop",
						method: "shell.exec",
						params: { command: source },
					});
				},
			);
			expect(reply.error).toBeUndefined();
			expect(String((reply.result as { stdout: string }).stdout)).toMatch(
				/1 a\.txt\s+2 b\.txt/u,
			);
			expect([launched, confirmations, reviews]).toEqual([1, 0, 0]);
			expect(taskIds).toHaveLength(1);
		} finally {
			await tasks.shutdown();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
