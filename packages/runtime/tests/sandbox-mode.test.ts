import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UiPickRequestParams } from "@codelia/protocol";
import { ProjectsPolicyStore, resolveStoragePaths } from "@codelia/storage";
import {
	resolveRuntimeEnvironment,
	runtimeEnvironmentPresets,
} from "../src/environment";
import type { Confirmation } from "../src/permissions/dispatch";
import type {
	ShellChild,
	ShellProtection,
} from "../src/permissions/shell-backend";
import { createToolContext } from "../src/rpc/tool";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { resolveRuntimeSandboxMode } from "../src/sandbox/mode";
import { createWriteTool } from "../src/tools/write";

const withWorkspace = async (
	run: (workspace: string, root: string) => Promise<void>,
) => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-sandbox-mode-")),
	);
	try {
		const workspace = path.join(root, "workspace");
		await mkdir(workspace);
		await run(workspace, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

test("trusted user policy translates legacy values and honors explicit sandbox selection", () =>
	withWorkspace(async (workspace, root) => {
		const store = new ProjectsPolicyStore(
			resolveStoragePaths({ rootOverride: path.join(root, "settings") }),
		);
		const environment = resolveRuntimeEnvironment();
		const local = {
			...environment,
			workspace: { ...environment.workspace, root: workspace },
		};
		const selection = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
			resolveRuntimeSandboxMode(local, { args, env, store });

		expect(await selection()).toEqual({
			value: "workspace-write",
			source: "fallback",
		});
		await store.save({
			version: 1,
			default: { sandbox_mode: "readonly" },
			projects: { [workspace]: { approval_mode: "trusted" } },
		});
		expect(await selection()).toEqual({
			value: "workspace-write",
			source: "project",
			legacy: "trusted",
		});
		expect(
			await selection([], { CODELIA_SANDBOX_MODE: "full-access" }),
		).toEqual({
			value: "full-access",
			source: "env",
		});
		expect(
			await selection(["--sandbox-mode", "readonly"], {
				CODELIA_SANDBOX_MODE: "full-access",
			}),
		).toEqual({ value: "readonly", source: "cli" });
		await expect(selection(["--sandbox-mode="])).rejects.toThrow(
			"Invalid --sandbox-mode",
		);

		await store.save({
			version: 1,
			projects: {
				[workspace]: {
					approval_mode: "full-access",
					sandbox_mode: "workspace-write",
				},
			},
		});
		expect(await selection()).toEqual({
			value: "workspace-write",
			source: "project",
		});

		const sdk = resolveRuntimeEnvironment({
			environment: {
				contract: {
					...runtimeEnvironmentPresets["tui-local"],
					workspace: {
						root: workspace,
						filesystem: "enabled",
						process: "runtime",
						sandboxMode: "readonly",
					},
				},
			},
		});
		expect(
			await resolveRuntimeSandboxMode(sdk, {
				args: ["--sandbox-mode", "full-access"],
				env: { CODELIA_SANDBOX_MODE: "full-access" },
				store,
			}),
		).toEqual({ value: "readonly", source: "sdk" });
	}));

test.skipIf(process.platform === "win32")(
	"a policy redirected into the checkout cannot grant its own authority",
	() =>
		withWorkspace(async (workspace, root) => {
			const config = path.join(workspace, ".codelia");
			await mkdir(config);
			const altered = path.join(config, "project.json");
			const settings = path.join(root, "settings");
			await mkdir(settings);
			const store = new ProjectsPolicyStore(
				resolveStoragePaths({ rootOverride: settings }),
			);
			await writeFile(
				altered,
				JSON.stringify({
					version: 1,
					default: { sandbox_mode: "full-access" },
				}),
			);
			await symlink(altered, store.getFilePath());
			const environment = resolveRuntimeEnvironment();
			expect(
				await resolveRuntimeSandboxMode(
					{
						...environment,
						workspace: { ...environment.workspace, root: workspace },
					},
					{ store, args: [], env: {} },
				),
			).toEqual({ value: "workspace-write", source: "fallback" });
		}),
);

test
	.skipIf(process.platform === "win32")
	.each(["readonly", "workspace-write", "full-access"] as const)(
	"sdk sandbox %s preserves explicit command admission and the protection of children",
	(value) =>
		withWorkspace(async (workspace) => {
			const confirmations: Confirmation[] = [];
			const launches: ShellProtection[] = [];
			const state = new RuntimeState();
			state.setRuntimeEnvironment({
				environment: {
					contract: {
						...runtimeEnvironmentPresets["tui-local"],
						workspace: {
							root: workspace,
							filesystem: "enabled",
							process: "runtime",
							sandboxMode: value,
						},
					},
				},
				adapters: {
					shellProtectionBackend: {
						supportsReadOnlyPaths: true,
						supports: () => true,
						launch: (_, protection) => {
							launches.push(protection);
							return {} as ShellChild;
						},
					},
					approvalService: {
						confirm: async (request) => {
							confirmations.push(request);
							return { requestId: request.requestId, choice: "allow_once" };
						},
					},
				},
			});
			state.runtimeSandboxRoot = workspace;
			state.sessionId = "fixture";
			const { authorizeRuntimeShell } = await import(
				"../src/permissions/runtime-approval"
			);
			const authorize = authorizeRuntimeShell(state);
			await authorize(
				{ cwd: workspace, origin: "parent_agent", source: "bun test" },
				(launch) => launch(),
			);
			expect(confirmations).toHaveLength(1);
			expect(launches[0]?.profile).toBe(
				value === "full-access"
					? "full-access"
					: value === "readonly"
						? "investigation"
						: "development",
			);
			expect(launches[0]?.writeRoots).toEqual(
				value === "workspace-write" ? [workspace] : [],
			);
			if (value === "workspace-write") {
				expect(confirmations[0]?.route.additional).toEqual([]);
				expect(confirmations[0]?.choices).not.toContain("grant_session");
			}
			if (value === "readonly") {
				expect(confirmations[0]?.choices).not.toContain("grant_session");
				const sandbox = await SandboxContext.create(workspace, {
					protectResources: true,
					sandboxMode: value,
				});
				expect(() => sandbox.resolvePath("fixture.txt", "write")).toThrow(
					"readonly",
				);
				expect(sandbox.resolvePath("fixture.txt", "read")).toBe(
					path.join(workspace, "fixture.txt"),
				);
			}
			if (value === "full-access") {
				expect(confirmations[0]?.preview).toContain("OS sandbox off");
				await authorize(
					{
						cwd: workspace,
						origin: "child_agent",
						owner: state.sessionId,
						source: "bun test",
					},
					(launch) => launch(),
				);
				expect(launches[1]?.profile).toBe("development");
				await authorize(
					{
						cwd: workspace,
						origin: "child_agent",
						owner: state.sessionId,
						childSandboxCeiling: "readonly",
						source: "bun test",
					},
					(launch) => launch(),
				);
				expect(launches[2]?.profile).toBe("investigation");
				expect(launches[2]?.writeRoots).toEqual([]);
			}
		}),
);

test.skipIf(process.platform === "win32")(
	"TUI shell confirmation preserves an explicitly configured workspace session grant",
	() =>
		withWorkspace(async (workspace) => {
			const { authorizeRuntimeShell, hasWorkspaceWriteGrant } = await import(
				"../src/permissions/runtime-approval"
			);
			const state = new RuntimeState();
			const launches: ShellProtection[] = [];
			state.setRuntimeEnvironment({
				environment: { preset: "tui-local" },
				adapters: {
					approvalShellAuthority: {
						investigation: true,
						workspaceWrite: "confirm",
						stdinPipe: "forbid",
					},
					shellProtectionBackend: {
						supportsReadOnlyPaths: true,
						supports: () => true,
						launch: (_, protection) => {
							launches.push(protection);
							return {} as ShellChild;
						},
					},
				},
			});
			state.runtimeSandboxRoot = workspace;
			state.sessionId = "workspace-grant-fixture";
			state.setUiCapabilities({
				supports_pick: true,
				supports_structured_approval: true,
			});

			const prompts: UiPickRequestParams[] = [];
			const choices = ["allow_once", "grant_session"];
			const stdout = process.stdout.write;
			process.stdout.write = ((chunk: string) => {
				const message = JSON.parse(chunk);
				if (message.method === "ui.pick.request") {
					const prompt: UiPickRequestParams = message.params;
					prompts.push(prompt);
					const choice = choices.shift();
					const option = prompt.items.find(({ id }) =>
						id.endsWith(`/${choice}`),
					);
					state.resolveUiResponse({
						jsonrpc: "2.0",
						id: message.id,
						result: { ids: option ? [option.id] : [] },
					});
				}
				return true;
			}) as typeof stdout;
			try {
				const authorize = authorizeRuntimeShell(state);
				const run = () =>
					authorize(
						{ cwd: workspace, origin: "operator", source: "bun test" },
						(launch) => launch(),
					);
				await run();
				expect(hasWorkspaceWriteGrant(state, workspace)).toBe(false);
				await run();
				expect(hasWorkspaceWriteGrant(state, workspace)).toBe(true);
			} finally {
				process.stdout.write = stdout;
			}
			expect(prompts).toHaveLength(2);
			for (const prompt of prompts) {
				expect(prompt.items.map(({ label }) => label)).toEqual([
					"Allow once",
					"Deny and continue",
					"Deny and stop turn",
					"Allow workspace writes for this session",
				]);
			}
			expect(launches.map(({ writeRoots }) => writeRoots)).toEqual([
				[workspace],
				[workspace],
			]);
		}),
);

test.skipIf(typeof process.geteuid !== "function")(
	"configured Auto approve runs immediately in readonly mode without workspace writes",
	() =>
		withWorkspace(async (workspace, root) => {
			const { authorizeRuntimeShell, hasWorkspaceWriteGrant } = await import(
				"../src/permissions/runtime-approval"
			);
			const { runtimeLocalAutoReview } = await import(
				"../src/permissions/local-reviewer"
			);
			const config = path.join(root, "config", "codelia");
			await mkdir(config, { mode: 0o700, recursive: true });
			await writeFile(
				path.join(config, "auto-review.json"),
				JSON.stringify({
					version: 3,
					enabled: true,
					mode: "pin",
					provider: "openai",
					model: "gpt-6-luna",
					categories: ["local_shell"],
				}),
				{ mode: 0o600 },
			);
			const restoreEnv = new Map<string, string | undefined>();
			for (const [name, value] of Object.entries({
				CODELIA_LAYOUT: "xdg",
				XDG_CONFIG_HOME: path.dirname(config),
				XDG_STATE_HOME: path.join(root, "state"),
				XDG_CACHE_HOME: path.join(root, "cache"),
				OPENAI_API_KEY: "synthetic-readonly-review-key",
			})) {
				restoreEnv.set(name, process.env[name]);
				process.env[name] = value;
			}
			const originalFetch = globalThis.fetch;
			const confirmations: Confirmation[] = [];
			const launches: ShellProtection[] = [];
			let reviewRequests = 0;
			try {
				globalThis.fetch = Object.assign(
					async () => {
						reviewRequests++;
						throw new Error(
							"Readonly launch unexpectedly tried to contact a reviewer",
						);
					},
					{ preconnect: originalFetch.preconnect },
				) as typeof globalThis.fetch;
				const state = new RuntimeState();
				state.setRuntimeEnvironment({
					adapters: {
						shellProtectionBackend: {
							supportsReadOnlyPaths: true,
							supports: () => true,
							launch: (_, protection) => {
								launches.push(protection);
								return {} as ShellChild;
							},
						},
						approvalService: {
							confirm: async (request) => {
								confirmations.push(request);
								return {
									requestId: request.requestId,
									choice: "deny_continue",
								};
							},
						},
					},
				});
				state.sandboxMode = { value: "readonly", source: "cli" };
				state.runtimeSandboxRoot = workspace;
				runtimeLocalAutoReview(state).configuration(workspace).enable();
				state.sessionId = "readonly-fixture";
				state.setUiCapabilities({ supports_structured_approval: true });
				state.beginRun("readonly-run", null, "Run the fixture tests.");
				const authorize = authorizeRuntimeShell(state);
				const run = () =>
					authorize(
						{ cwd: workspace, origin: "parent_agent", source: "bun test" },
						(launch) => launch(),
					);
				await run();
				await run();
				expect(confirmations).toHaveLength(0);
				expect(reviewRequests).toBe(0);
				expect(
					launches.map(({ profile, writeRoots }) => ({ profile, writeRoots })),
				).toEqual([
					{ profile: "investigation", writeRoots: [] },
					{ profile: "investigation", writeRoots: [] },
				]);
				expect(hasWorkspaceWriteGrant(state, workspace)).toBe(false);
				state.finishRun("readonly-run");
			} finally {
				globalThis.fetch = originalFetch;
				for (const [name, original] of restoreEnv) {
					if (original === undefined) delete process.env[name];
					else process.env[name] = original;
				}
			}
		}),
);

test.skipIf(typeof process.geteuid !== "function")(
	"a shared or other-writable settings file cannot select full-access",
	() =>
		withWorkspace(async (workspace, root) => {
			const store = new ProjectsPolicyStore(
				resolveStoragePaths({ rootOverride: path.join(root, "settings") }),
			);
			await store.save({
				version: 1,
				default: { sandbox_mode: "full-access" },
			});
			const environment = resolveRuntimeEnvironment();
			const select = () =>
				resolveRuntimeSandboxMode(
					{
						...environment,
						workspace: { ...environment.workspace, root: workspace },
					},
					{ store, args: [], env: {} },
				);
			const policy = store.getFilePath();
			expect(await select()).toEqual({
				value: "full-access",
				source: "default",
			});
			await chmod(policy, 0o622);
			expect(await select()).toEqual({
				value: "workspace-write",
				source: "fallback",
			});
			await chmod(policy, 0o600);
			await link(policy, path.join(root, "shared-policy.json"));
			expect(await select()).toEqual({
				value: "workspace-write",
				source: "fallback",
			});
		}),
);

test("workspace-write admits registered file editing within the selected scope and keeps SDK ceilings", () =>
	withWorkspace(async (workspace) => {
		const { createRuntimeToolApproval } = await import(
			"../src/permissions/tool-approval"
		);
		let prompts = 0;
		const file = path.join(workspace, "file.txt");
		await writeFile(file, "before");
		const input = JSON.stringify({
			file_path: "file.txt",
			content: "after",
			expected_hash: createHash("sha256").update("before").digest("hex"),
		});

		const run = async (
			mode: "readonly" | "workspace-write",
			hostForbids: boolean,
		) => {
			const state = new RuntimeState();
			state.runtimeSandboxRoot = workspace;
			state.setRuntimeEnvironment({
				environment: {
					contract: {
						...runtimeEnvironmentPresets["tui-local"],
						workspace: {
							root: workspace,
							filesystem: "enabled",
							process: "runtime",
							sandboxMode: mode,
						},
					},
				},
				adapters: {
					...(hostForbids
						? {
								approvalShellAuthority: {
									investigation: true,
									workspaceWrite: "forbid",
									stdinPipe: "forbid",
								},
							}
						: {}),
					approvalService: {
						confirm: async (request) => {
							prompts++;
							return { requestId: request.requestId, choice: "allow_once" };
						},
					},
				},
			});
			const sandbox = await SandboxContext.create(workspace, {
				sandboxMode: mode,
				protectResources: true,
			});
			const sandboxKey = createSandboxKey(sandbox);
			const tool = createWriteTool(sandboxKey);
			const authorize = createRuntimeToolApproval({
				state,
				sandboxKey,
				builtinNames: new Set(["write"]),
			});
			return authorize
				.wrap(tool, "builtin")
				.executeRaw(input, createToolContext());
		};

		await expect(run("readonly", false)).rejects.toThrow("readonly");
		await expect(run("workspace-write", true)).rejects.toThrow(
			"outside_authority_ceiling",
		);
		expect(await readFile(file, "utf8")).toBe("before");
		expect((await run("workspace-write", false)).type).toBe("json");
		expect(await readFile(file, "utf8")).toBe("after");
		expect(prompts).toBe(0);
	}));
