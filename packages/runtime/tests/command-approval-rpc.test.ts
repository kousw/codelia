import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { RpcResponse } from "@codelia/protocol";
import { TaskRegistryStore } from "@codelia/storage";
import { mergeSessionModelOverrideIntoMeta } from "../src/effective-model";
import { runtimeEnvironmentPresets } from "../src/environment";
import type { Confirmation } from "../src/permissions/dispatch";
import { LaunchRuleStore } from "../src/permissions/launch-rules";
import { authorizeRuntimeShell } from "../src/permissions/runtime-approval";
import type { ShellChild } from "../src/permissions/shell-backend";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { createSandboxKey, SandboxContext } from "../src/sandbox/context";
import { TaskManager } from "../src/tasks";
import { createReadTool } from "../src/tools/read";
import { VolatileSessionStateStore } from "../src/volatile-stores";
import {
	fixtureShellAuthority,
	fixtureShellBackend,
} from "./fixtures/approval";

const summary = (samples: number[]) => {
	const ordered = [...samples].sort((a, b) => a - b);
	return {
		p50: ordered[Math.ceil(ordered.length * 0.5) - 1],
		p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
	};
};

test.each(process.platform === "win32" ? ["direct"] : ["direct", "symlink"])(
	"direct run resume with a saved model preserves %s workspace MCP approval",
	async (kind) => {
		const base = realpathSync(
			mkdtempSync(path.join(tmpdir(), "codelia-mcp-resume-rpc-")),
		);
		const root = path.join(base, "workspace");
		const state = new RuntimeState();
		const sessions = new VolatileSessionStateStore();
		const output = process.stdout.write;
		const started = Promise.withResolvers<RpcResponse>();
		const finished = Promise.withResolvers<void>();
		let prompt = Promise.withResolvers<Confirmation>();
		let answer = Promise.withResolvers<{
			requestId: string;
			choice: "allow_once";
		}>();
		const launches: { root: string; cwd: string }[] = [];
		try {
			mkdirSync(root);
			const launchRoot =
				kind === "symlink" ? path.join(base, "workspace-link") : root;
			if (kind === "symlink") symlinkSync(root, launchRoot, "dir");
			state.setRuntimeEnvironment({
				adapters: {
					approvalService: {
						confirm: async (request) => {
							prompt.resolve(request);
							return answer.promise;
						},
					},
					shellProtectionBackend: {
						...fixtureShellBackend,
						launch: (_invocation, { root, cwd }) => {
							launches.push({ root, cwd });
							return {} as ShellChild;
						},
					},
				},
			});
			state.runtimeWorkingDir = launchRoot;
			state.runtimeSandboxRoot = launchRoot;
			await sessions.save({
				schema_version: 1,
				session_id: "saved-model",
				updated_at: new Date().toISOString(),
				messages: [],
				meta: mergeSessionModelOverrideIntoMeta(undefined, {
					provider: "openai",
					name: "gpt-6.1-terra",
				}),
			});
			const { processMessage } = createRuntimeHandlers({
				state,
				sessionStateStore: sessions,
				log: () => {},
				getAgent: async () => {
					const sandbox = await SandboxContext.create(launchRoot, {
						protectResources: true,
					});
					state.runtimeWorkingDir = sandbox.workingDir;
					state.runtimeSandboxRoot = sandbox.rootDir;
					return new Agent({
						llm: {
							provider: "openai",
							model: "gpt-6.1-terra",
							ainvoke: async () => ({
								messages: [{ role: "assistant", content: "Done" }],
							}),
						},
						tools: [],
						systemPrompt: "Fixture",
						compaction: null,
						toolOutputCache: null,
					});
				},
			});
			process.stdout.write = ((chunk: string | Uint8Array) => {
				const message = JSON.parse(String(chunk));
				if (message.id === "resume") started.resolve(message);
				if (
					message.method === "run.status" &&
					message.params.status === "completed"
				)
					finished.resolve();
				return true;
			}) as typeof output;
			const mcp = () =>
				authorizeRuntimeShell(state)(
					{
						argv: [process.execPath, "--version"],
						cwd: launchRoot,
						origin: "mcp_service",
						stdin: "pipe",
					},
					(admit) => admit(),
				);
			const pending = mcp();
			const first = await prompt.promise;
			processMessage({
				jsonrpc: "2.0",
				id: "resume",
				method: "run.start",
				params: {
					session_id: "saved-model",
					input: { type: "text", text: "Continue" },
				},
			});
			expect((await started.promise).error).toBeUndefined();
			expect(state.sessionModelOverride?.name).toBe("gpt-6.1-terra");
			expect(state.runtimeSandboxRoot).toBe(root);
			answer.resolve({ requestId: first.requestId, choice: "allow_once" });
			await pending;
			await finished.promise;

			prompt = Promise.withResolvers<Confirmation>();
			answer = Promise.withResolvers<{
				requestId: string;
				choice: "allow_once";
			}>();
			const stale = mcp();
			const second = await prompt.promise;
			state.reviseApprovalAuthority();
			answer.resolve({ requestId: second.requestId, choice: "allow_once" });
			await expect(stale).rejects.toThrow("approval_expired");
			prompt = Promise.withResolvers<Confirmation>();
			answer = Promise.withResolvers<{
				requestId: string;
				choice: "allow_once";
			}>();
			const different = mcp();
			const third = await prompt.promise;
			state.runtimeSandboxRoot = base;
			answer.resolve({ requestId: third.requestId, choice: "allow_once" });
			await expect(different).rejects.toThrow("approval_expired");
			expect(launches).toEqual([{ root, cwd: root }]);
		} finally {
			process.stdout.write = output;
			rmSync(base, { recursive: true, force: true });
		}
	},
);

test("real read, status and saved shell RPCs avoid review evidence and reload policy only after revision", async () => {
	const base = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-approval-rpc-")),
	);
	const root = path.join(base, "workspace");
	const sibling = path.join(base, "adjacent");
	mkdirSync(path.join(root, "tests"), { recursive: true });
	mkdirSync(sibling);
	writeFileSync(path.join(root, "tests", "empty.test.ts"), "");
	writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ scripts: { typecheck: "true" } }),
	);
	const file = path.join(sibling, "ordinary.txt");
	writeFileSync(file, "sibling file");
	const store = new LaunchRuleStore(path.join(base, "rules"));
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(base, "tasks")),
	});
	const state = new RuntimeState();
	let revisions = "1";
	let loads = 0;
	let prompts = 0;
	let evidence = 0;
	let reviews = 0;
	let launches = 0;
	const backendTimes: number[] = [];
	const output = process.stdout.write;
	const pending = new Map<string, (value: RpcResponse) => void>();
	let sequence = 0;
	try {
		state.setRuntimeEnvironment({
			environment: {
				contract: {
					...runtimeEnvironmentPresets["tui-local"],
					workspace: { root, filesystem: "enabled", process: "runtime" },
					config: { source: "host" },
				},
			},
			adapters: {
				configProvider: {
					resolvePermissionsConfig: async () => {
						loads++;
						return {};
					},
				},
				approvalPolicyRevision: () => revisions,
				approvalShellAuthority: fixtureShellAuthority,
				approvalLaunchRuleStore: store,
				shellProtectionBackend: {
					supportsReadOnlyPaths: fixtureShellBackend.supportsReadOnlyPaths,
					supportsCommandBinding: fixtureShellBackend.supportsCommandBinding,
					supports: fixtureShellBackend.supports,
					supportsLaunchBinding: fixtureShellBackend.supportsLaunchBinding,
					exactLaunchBindingId: "fixture/1",
					supportsExactLaunchBinding:
						fixtureShellBackend.supportsExactLaunchBinding,
					launch: (invocation, protection) => {
						launches++;
						const start = performance.now();
						const child = fixtureShellBackend.launch(invocation, protection);
						backendTimes.push(performance.now() - start);
						return child;
					},
				},
				approvalService: {
					confirm: async ({ requestId, choices }) => {
						prompts++;
						expect(choices).toContain("save_project");
						return { requestId, choice: "save_project" };
					},
				},
				approvalReviewer: {
					categories: ["local_test"],
					buildEvidence: async () => {
						evidence++;
						return null;
					},
					review: async () => {
						reviews++;
						return null;
					},
				},
			},
		});
		state.runtimeWorkingDir = root;
		state.runtimeSandboxRoot = root;
		const sandbox = await SandboxContext.create(root, {
			protectResources: true,
			extraProtectedPaths: [store.directory],
		});
		const read = createReadTool(createSandboxKey(sandbox));
		const approve = createRuntimeToolApproval({
			state,
			builtinNames: new Set(["read"]),
		});
		state.tools = [approve.wrap(read, "builtin")];
		const { processMessage } = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
			taskManager: tasks,
			sessionStateStore: new VolatileSessionStateStore(),
		});
		process.stdout.write = ((chunk: string) => {
			for (const line of chunk.trim().split("\n")) {
				const response = JSON.parse(line) as RpcResponse;
				const handler = response.id && pending.get(String(response.id));
				if (handler && ("result" in response || "error" in response))
					handler(response);
			}
			return true;
		}) as typeof process.stdout.write;
		const call = (method: string, params: unknown, requestId?: string) =>
			new Promise<RpcResponse>((resolve, reject) => {
				const id = requestId ?? String(++sequence);
				const deadline = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`No RPC response for ${method}`));
				}, 2000);
				pending.set(id, (response) => {
					clearTimeout(deadline);
					pending.delete(id);
					resolve(response);
				});
				processMessage({ jsonrpc: "2.0", method, id, params });
			});
		const start = performance.now();
		const cold = await call("shell.start", { command: "bun run typecheck" });
		const coldMs = performance.now() - start;
		expect(cold.error).toBeUndefined();
		expect([loads, prompts, evidence, reviews, launches]).toEqual([
			1, 1, 1, 0, 1,
		]);
		const taskId = (cold.result as { task_id: string }).task_id;
		const categories = {
			read: [] as number[],
			status: [] as number[],
			savedLaunch: [] as number[],
		};
		for (let index = 0; index < 100; index++) {
			const readStart = performance.now();
			const response = await call("tool.call", {
				name: "read",
				arguments: { file_path: file },
			});
			categories.read.push(performance.now() - readStart);
			expect(JSON.stringify(response.result)).toContain("sibling file");
			const statusStart = performance.now();
			expect(
				(await call("task.status", { task_id: taskId })).error,
			).toBeUndefined();
			categories.status.push(performance.now() - statusStart);
		}
		expect([loads, prompts, evidence, reviews, launches]).toEqual([
			1, 1, 1, 0, 1,
		]);
		for (let index = 0; index < 20; index++) {
			const launchStart = performance.now();
			expect(
				(await call("shell.start", { command: "bun run typecheck" })).error,
			).toBeUndefined();
			categories.savedLaunch.push(performance.now() - launchStart);
		}
		expect([loads, prompts, evidence, reviews, launches]).toEqual([
			1, 1, 1, 0, 21,
		]);
		revisions = "2";
		expect(
			(await call("shell.start", { command: "bun run typecheck" })).error,
		).toBeUndefined();
		expect([loads, prompts, evidence, reviews, launches]).toEqual([
			2, 1, 1, 0, 22,
		]);
		const launch = { command: "bun run typecheck" };
		expect(
			(await call("shell.start", launch, "receipt")).error,
		).toBeUndefined();
		expect(
			(await call("shell.start", launch, "receipt")).error?.message,
		).toContain("approval_receipt_expired");
		state.sessionId = "another-owner";
		expect(
			(await call("shell.start", launch, "receipt")).error?.message,
		).toContain("approval_receipt_expired");
		expect(launches).toBe(23);

		expect((await call("initialize", {})).error).toBeUndefined();
		expect(
			(await call("shell.start", launch, "receipt")).error,
		).toBeUndefined();
		expect(launches).toBe(24);
		process.stdout.write = output;
		if (process.env.CODELIA_APPROVAL_MEASURE === "1")
			console.log("RPC elapsed ms", {
				coldMs,
				read: summary(categories.read),
				status: summary(categories.status),
				savedLaunch: summary(categories.savedLaunch),
				fixtureProcessStart: summary(backendTimes),
			});
	} finally {
		process.stdout.write = output;
		await tasks.shutdown();
		rmSync(base, { recursive: true, force: true });
	}
}, 20000);

test("session.open scopes shell keys and IDs before model and RPC task operations", async () => {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), "codelia-owned-shell-")),
	);
	const registry = new TaskRegistryStore(path.join(root, "tasks"));
	const tasks = new TaskManager({ registry });
	const sessions = new VolatileSessionStateStore();
	const state = new RuntimeState();
	state.runtimeWorkingDir = root;
	state.runtimeSandboxRoot = root;
	const { createToolSessionContextKey } = await import(
		"../src/tools/session-context"
	);
	const {
		createShellStatusTool,
		createShellLogsTool,
		createShellStdinWriteTool,
	} = await import("../src/tools/shell");
	const { createToolContext } = await import("../src/rpc/tool");
	const opts = {
		taskManager: tasks,
		sessionContextKey: createToolSessionContextKey(() => state.sessionId),
	};
	const statusTool = createShellStatusTool(opts);
	const logsTool = createShellLogsTool(opts);
	const stdinTool = createShellStdinWriteTool(opts);
	const { processMessage } = createRuntimeHandlers({
		state,
		getAgent: async () => ({}) as Agent,
		log: () => {},
		taskManager: tasks,
		sessionStateStore: sessions,
	});
	let number = 0;
	const call = (method: string, params: unknown) =>
		new Promise<RpcResponse>((resolve, reject) => {
			const original = process.stdout.write;
			const id = `owner-${++number}`;
			const stop = () => {
				clearTimeout(timeout);
				process.stdout.write = original;
			};
			const timeout = setTimeout(() => {
				stop();
				reject(new Error("RPC response missing"));
			}, 1000);
			process.stdout.write = ((chunk: string) => {
				for (const line of String(chunk).trim().split("\n")) {
					const response = JSON.parse(line) as RpcResponse;
					if (response.id === id) {
						stop();
						resolve(response);
					}
				}
				return true;
			}) as typeof process.stdout.write;
			processMessage({ method, params, id, jsonrpc: "2.0" });
		});
	try {
		for (const session of ["one", "two"]) {
			const stamp = new Date().toISOString();
			await sessions.save({
				schema_version: 1,
				session_id: session,
				updated_at: stamp,
				messages: [],
			});
			await registry.upsert({
				version: 1,
				task_id: `task-${session}`,
				kind: "shell",
				workspace_mode: "live_workspace",
				state: "completed",
				key: "shared-key",
				parent_session_id: session,
				owner_runtime_id: tasks.ownerRuntimeId,
				owner_pid: process.pid,
				created_at: stamp,
				updated_at: stamp,
				result: { stdout: `output-${session}` },
			});
		}
		for (const [ours, theirs] of [
			["one", "two"],
			["two", "one"],
		]) {
			expect(
				(await call("session.open", { session_id: ours })).error,
			).toBeUndefined();
			for (const method of [
				"shell.status",
				"shell.output",
				"shell.wait",
				"shell.cancel",
				"task.status",
				"task.wait",
				"task.result",
				"task.cancel",
			]) {
				expect(
					(
						await call(method, {
							task_id: `task-${ours}`,
							...(method === "shell.output" ? { stream: "stdout" } : {}),
						})
					).error,
				).toBeUndefined();
				const denied = await call(method, {
					task_id: `task-${theirs}`,
					...(method === "shell.output" ? { stream: "stdout" } : {}),
				});
				expect(denied.error?.message).toMatch(/not found/iu);
				expect(denied.result).toBeUndefined();
			}
			for (const method of ["shell.list", "task.list"]) {
				const listed = JSON.stringify((await call(method, {})).result);
				expect(listed).toContain(`task-${ours}`);
				expect(listed).not.toContain(`task-${theirs}`);
			}
			expect(
				(
					await statusTool.executeRaw(
						'{"key":"shared-key"}',
						createToolContext(),
					)
				).type,
			).toBe("json");
			const log = JSON.stringify(
				await logsTool.executeRaw('{"key":"shared-key"}', createToolContext()),
			);
			expect(log).toContain(`output-${ours}`);
			expect(log).not.toContain(`output-${theirs}`);
			await expect(
				stdinTool.executeRaw(
					'{"key":"shared-key","text":"ignored"}',
					createToolContext(),
				),
			).rejects.toThrow(/task_input_unavailable/);
		}
	} finally {
		await tasks.shutdown();
		rmSync(root, { recursive: true, force: true });
	}
});
