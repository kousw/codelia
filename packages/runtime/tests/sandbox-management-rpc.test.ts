import { expect, test } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent, type BaseChatModel } from "@codelia/core";
import type { RpcResponse, SandboxSetParams } from "@codelia/protocol";
import { resolveStoragePaths } from "@codelia/storage";
import { createAgentFactory } from "../src/agent-factory";
import { runtimeEnvironmentPresets } from "../src/environment";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { resolveRuntimeSandboxMode } from "../src/sandbox/mode";
import {
	VolatileRunEventStoreFactory,
	VolatileSessionStateStore,
} from "../src/volatile-stores";
import { fixtureShellBackend } from "./fixtures/approval";

const waitFor = async (ready: () => boolean) => {
	const end = Date.now() + 5000;
	while (!ready()) {
		if (Date.now() >= end) throw new Error("Timed out waiting for RPC fixture");
		await Bun.sleep(5);
	}
};

const initialize = {
	protocol_version: "0",
	client: { name: "sandbox-fixture", version: "0" },
	ui_capabilities: { supports_auth_management: true },
};

const set = (mode: SandboxSetParams["mode"]): SandboxSetParams => ({
	scope: "project",
	mode,
});

const withFixture = async (
	run: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>,
) => {
	const root = await realpath(
		await mkdtemp(path.join(tmpdir(), "codelia-sandbox-rpc-")),
	);
	const saved = new Map<string, string | undefined>();
	const original = process.stdout.write;
	const originalFetch = globalThis.fetch;
	const env = (key: string, value: string) => {
		if (!saved.has(key)) saved.set(key, process.env[key]);
		process.env[key] = value;
	};
	try {
		globalThis.fetch = Object.assign(
			async (url: Parameters<typeof fetch>[0]) => {
				if (String(url) === "https://models.dev/api.json")
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
				throw new Error("Unexpected network call in sandbox RPC fixture");
			},
			{ preconnect: originalFetch.preconnect },
		);
		await run(await prepareFixture(root, env));
	} finally {
		process.stdout.write = original;
		globalThis.fetch = originalFetch;
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
};

async function prepareFixture(
	root: string,
	env: (key: string, value: string) => void,
) {
	env("CODELIA_LAYOUT", "xdg");
	env("XDG_CONFIG_HOME", path.join(root, "config"));
	env("XDG_CACHE_HOME", path.join(root, "cache"));
	env("XDG_STATE_HOME", path.join(root, "state"));
	env("OPENAI_API_KEY", "fixture-only");
	const { configDir, configFile, projectsFile } = resolveStoragePaths();
	await mkdir(configDir, { recursive: true, mode: 0o700 });
	await writeFile(
		configFile,
		JSON.stringify({
			version: 1,
			model: { provider: "openai", name: "gpt-6-astra" },
		}),
	);
	const primary = path.join(root, "primary");
	const other = path.join(root, "other");
	await Promise.all([mkdir(primary), mkdir(other)]);
	const initialPolicy = {
		version: 1,
		default: { approval_mode: "minimal" },
		projects: {
			[primary]: { approval_mode: "trusted" },
			[other]: { sandbox_mode: "full-access", additional_metadata: "keep" },
		},
	};
	await writeFile(projectsFile, JSON.stringify(initialPolicy), { mode: 0o600 });
	const replies = new Map<string, RpcResponse>();
	let sequence = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		for (const line of String(chunk).trim().split("\n")) {
			const message = JSON.parse(line);
			if (!message.method) replies.set(message.id, message);
		}
		return true;
	}) as typeof process.stdout.write;
	const client = async (
		workspace: string,
		flags: {
			args?: readonly string[];
			env?: NodeJS.ProcessEnv;
			sdk?: boolean;
		} = {},
	) => {
		env("CODELIA_SANDBOX_ROOT", workspace);
		const state = new RuntimeState();
		state.setRuntimeEnvironment({
			environment: flags.sdk
				? {
						contract: {
							...runtimeEnvironmentPresets["tui-local"],
							workspace: {
								root: workspace,
								filesystem: "enabled",
								process: "runtime",
								sandboxMode: "readonly",
							},
						},
					}
				: { preset: "tui-local" },
			adapters: { shellProtectionBackend: fixtureShellBackend },
		});
		state.runtimeSandboxRoot = workspace;
		state.runtimeWorkingDir = workspace;
		state.sandboxMode = await resolveRuntimeSandboxMode(
			state.effectiveEnvironment,
			{ args: flags.args ?? [], env: flags.env ?? {} },
		);
		const sessions = new VolatileSessionStateStore();
		const factory = createAgentFactory(state, { sessionStateStore: sessions });
		let blocker: (() => Promise<void>) | undefined;
		let finishGate: Promise<void> | undefined;
		let agentBuilt: Agent | null = null;
		let writes = 0;
		let invoked = false;
		const ainvoke: BaseChatModel["ainvoke"] = async () => {
			if (invoked) {
				await finishGate;
				return { messages: [{ role: "assistant", content: "Finished" }] };
			}
			invoked = true;
			return {
				messages: [
					{
						role: "assistant",
						content: "",
						tool_calls: [
							{
								id: `write-${++writes}`,
								type: "function",
								function: {
									name: "write",
									arguments: JSON.stringify({
										file_path: `write-${writes}.txt`,
										content: "from sandbox fixture",
									}),
								},
							},
						],
					},
				],
			};
		};
		const { processMessage } = createRuntimeHandlers({
			state,
			sessionStateStore: sessions,
			runEventStoreFactory: new VolatileRunEventStoreFactory(),
			log: () => {},
			getAgent: async () => {
				await blocker?.();
				if (state.agent === agentBuilt && agentBuilt) return agentBuilt;
				await factory();
				agentBuilt = new Agent({
					llm: { provider: "openai", model: "gpt-6-astra", ainvoke },
					tools: state.tools ?? [],
					systemPrompt: "Fixture",
					compaction: null,
					toolOutputCache: null,
				});
				state.agent = agentBuilt;
				return agentBuilt;
			},
		});
		const call = async (method: string, params?: unknown) => {
			const id = `sandbox-fixture-${++sequence}`;
			processMessage({ jsonrpc: "2.0", id, method, params });
			await waitFor(() => replies.has(id));
			return replies.get(id) as RpcResponse;
		};
		const start = () => {
			invoked = false;
			return call("run.start", {
				input: { type: "text", text: "Write a fixture file." },
			});
		};
		return {
			state,
			call,
			start,
			block: (fn: () => Promise<void>) => {
				blocker = fn;
			},
			blockFinish: (promise: Promise<void>) => {
				finishGate = promise;
			},
		};
	};
	return { client, primary, other, projectsFile, initialPolicy };
}

test.skipIf(process.platform === "win32")(
	"project sandbox RPC reports live authority, serializes run admission and applies the new mode on the next run",
	() =>
		withFixture(
			async ({ client, primary, other, projectsFile, initialPolicy }) => {
				const { state, call, start, block, blockFinish } =
					await client(primary);
				expect((await call("initialize", initialize)).result).toMatchObject({
					server_capabilities: { supports_sandbox_mode_management: true },
					sandbox_mode: {
						value: "workspace-write",
						source: "project",
						legacy: "trusted",
					},
				});
				state.updateUiContext({ cwd: other, workspace_root: other });
				const initial = await call("sandbox.get");
				expect(initial.result).toMatchObject({
					effective: {
						value: "workspace-write",
						source: "project",
						legacy: "trusted",
					},
					applied: null,
					project: { writable: true },
					choices: [
						{ id: "readonly" },
						{ id: "workspace-write" },
						{ id: "full-access" },
					],
				});
				expect(
					(await call("sandbox.set", set("workspace-write"))).error?.data,
				).toEqual({ reason: "already_effective" });
				expect(
					(await call("sandbox.set", { ...set("readonly"), workspace: other }))
						.error,
				).toBeDefined();
				let waiting = false;
				const agentBuild = Promise.withResolvers<void>();
				const model = Promise.withResolvers<void>();
				block(async () => {
					waiting = true;
					await agentBuild.promise;
				});
				blockFinish(model.promise);
				const started = start();
				await waitFor(() => waiting);
				const competing = call("sandbox.set", set("readonly"));
				agentBuild.resolve();
				try {
					expect((await started).error).toBeUndefined();
					expect((await competing).error?.data).toEqual({
						reason: "runtime_busy",
					});
					expect((await call("sandbox.get")).result).toMatchObject({
						applied: { value: "workspace-write", target: "run" },
						project: { writable: false, reason: "runtime_busy" },
					});
				} finally {
					model.resolve();
				}
				await waitFor(() => state.activeRunId === null);
				expect(await readFile(path.join(primary, "write-1.txt"), "utf8")).toBe(
					"from sandbox fixture",
				);
				expect((await call("sandbox.get")).result).toMatchObject({
					applied: { value: "workspace-write", target: "agent" },
				});
				const revision = state.approvalAuthorityGeneration;
				expect(
					(await call("sandbox.set", set("readonly"))).result,
				).toMatchObject({
					effective: { value: "readonly", source: "project" },
					applied: null,
				});
				expect(state.approvalAuthorityGeneration).toBeGreaterThan(revision);
				expect((await call("permissions.list")).result).toMatchObject({
					sandbox_mode: { value: "readonly", source: "project" },
					approval_mode: null,
				});
				expect(JSON.parse(await readFile(projectsFile, "utf8"))).toEqual({
					...initialPolicy,
					projects: {
						...initialPolicy.projects,
						[primary]: { approval_mode: "trusted", sandbox_mode: "readonly" },
					},
				});
				expect((await start()).error).toBeUndefined();
				await waitFor(() => state.activeRunId === null);
				await expect(
					readFile(path.join(primary, "write-2.txt")),
				).rejects.toMatchObject({ code: "ENOENT" });
				expect((await call("sandbox.get")).result).toMatchObject({
					applied: { value: "readonly", target: "agent" },
				});
			},
		),
);

test.skipIf(process.platform === "win32")(
	"independent runtimes merge sandbox updates and reject fixed or unsafe sources",
	() =>
		withFixture(
			async ({ client, primary, other, projectsFile, initialPolicy }) => {
				const first = await client(primary);
				const second = await client(other);
				const before = await readFile(projectsFile, "utf8");
				for (const [options, reason] of [
					[{ args: ["--sandbox-mode=full-access"] }, "cli_override"],
					[{ env: { CODELIA_SANDBOX_MODE: "readonly" } }, "env_override"],
					[{ sdk: true }, "sdk_managed"],
				] as const) {
					const fixed = await client(primary, options);
					expect((await fixed.call("sandbox.get")).result).toMatchObject({
						project: { writable: false, reason },
					});
					expect(
						(await fixed.call("sandbox.set", set("workspace-write"))).error
							?.data,
					).toMatchObject({ reason });
				}
				expect(await readFile(projectsFile, "utf8")).toBe(before);
				await chmod(projectsFile, 0o666);
				expect((await first.call("sandbox.get")).result).toMatchObject({
					project: { writable: false, reason: "policy_store_unavailable" },
				});
				expect(
					(await first.call("sandbox.set", set("readonly"))).error?.data,
				).toEqual({ reason: "policy_store_unavailable" });
				await chmod(projectsFile, 0o600);
				const configAncestor = path.dirname(path.dirname(projectsFile));
				await chmod(configAncestor, 0o777);
				const restarted = await client(other);
				expect(restarted.state.sandboxMode).toEqual({
					value: "workspace-write",
					source: "fallback",
				});
				expect((await restarted.call("sandbox.get")).result).toMatchObject({
					project: { writable: false, reason: "policy_store_unavailable" },
				});
				await chmod(configAncestor, 0o700);
				const lock = Bun.spawn(
					[
						process.execPath,
						"-e",
						'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); db.exec("PRAGMA user_version = 1; BEGIN IMMEDIATE"); console.log("held"); setInterval(() => { db.query("SELECT 1").get(); }, 100);',
						path.join(
							path.dirname(projectsFile),
							".projects-policy-lock.sqlite",
						),
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				try {
					const output = lock.stdout.getReader();
					try {
						const ready = await output.read();
						expect(new TextDecoder().decode(ready.value)).toBe("held\n");
					} finally {
						output.releaseLock();
					}
					expect(
						(await first.call("sandbox.set", set("readonly"))).error?.data,
					).toEqual({ reason: "policy_store_busy" });
				} finally {
					lock.kill("SIGKILL");
					await lock.exited;
				}
				const results = await Promise.all([
					first.call("sandbox.set", set("readonly")),
					second.call("sandbox.set", set("workspace-write")),
				]);
				for (const result of results) expect(result.error).toBeUndefined();
				expect(JSON.parse(await readFile(projectsFile, "utf8"))).toEqual({
					...initialPolicy,
					projects: {
						[primary]: { approval_mode: "trusted", sandbox_mode: "readonly" },
						[other]: {
							sandbox_mode: "workspace-write",
							additional_metadata: "keep",
						},
					},
				});
			},
		),
);

test("sandbox status remains available when user policy ACLs cannot be verified", () =>
	withFixture(async ({ client, primary }) => {
		const geteuid = Object.getOwnPropertyDescriptor(process, "geteuid");
		Object.defineProperty(process, "geteuid", {
			configurable: true,
			value: undefined,
		});
		try {
			for (const [flags, reason] of [
				[{}, "policy_acl_unverified"],
				[{ args: ["--sandbox-mode=full-access"] }, "cli_override"],
				[{ env: { CODELIA_SANDBOX_MODE: "readonly" } }, "env_override"],
				[{ sdk: true }, "sdk_managed"],
			] as const) {
				const runtime = await client(primary, flags);
				expect((await runtime.call("sandbox.get")).result).toMatchObject({
					effective: runtime.state.sandboxMode,
					project: { writable: false, reason },
				});
				expect(
					(await runtime.call("sandbox.set", set("workspace-write"))).error
						?.data,
				).toEqual({ reason });
			}
		} finally {
			if (geteuid) Object.defineProperty(process, "geteuid", geteuid);
			else Reflect.deleteProperty(process, "geteuid");
		}
	}));
