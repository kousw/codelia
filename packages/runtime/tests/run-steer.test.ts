import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	PolledMessage,
} from "@codelia/core";
import {
	type InitializeResult,
	RPC_ERROR_CODE,
	type RpcMessage,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
	type RunStartResult,
	type RunStatusNotify,
	type RunSteerResult,
} from "@codelia/protocol";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

const TEST_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const isRpcResponse = (value: unknown): value is RpcResponse =>
	isRpcMessage(value) && "id" in value && !("method" in value);

const isRpcNotification = (value: unknown): value is RpcNotification =>
	isRpcMessage(value) && !("id" in value) && "method" in value;

const waitFor = async (
	condition: () => boolean,
	timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(15);
	}
	throw new Error("Timed out waiting for condition");
};

const createStdoutCapture = () => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const messages: RpcMessage[] = [];

	const write = (chunk: string | Uint8Array): boolean => {
		const text =
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		buffer += text;
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRpcMessage(parsed)) {
						messages.push(parsed);
					}
				} catch {
					// ignore
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	};

	return {
		start() {
			process.stdout.write = write;
		},
		stop() {
			process.stdout.write = originalWrite;
		},
		messages,
		async waitForResponse(id: string): Promise<RpcResponse> {
			let result: RpcResponse | undefined;
			await waitFor(() => {
				result = messages.find(
					(msg): msg is RpcResponse => isRpcResponse(msg) && msg.id === id,
				);
				return !!result;
			});
			if (!result) throw new Error(`Response not found for id=${id}`);
			return result;
		},
		async waitForRunStatus(
			runId: string,
			status: RunStatusNotify["status"],
		): Promise<RunStatusNotify> {
			let matched: RunStatusNotify | undefined;
			await waitFor(() => {
				for (const msg of messages) {
					if (!isRpcNotification(msg) || msg.method !== "run.status") {
						continue;
					}
					const params = msg.params as RunStatusNotify | undefined;
					if (params?.run_id === runId && params?.status === status) {
						matched = params;
						return true;
					}
				}
				return false;
			});
			if (!matched) {
				throw new Error(`run.status ${status} not found for run=${runId}`);
			}
			return matched;
		},
	};
};

const withTempStorageEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-steer-test-"),
	);
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	setEnv("CODELIA_LAYOUT", "xdg");
	setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
	setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
	setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
	setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

	const paths = resolveStoragePaths();
	await ensureStorageDirs(paths);

	return {
		async cleanup() {
			for (const [key, value] of envSnapshot) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		},
	};
};

describe("runtime run.steer RPC", () => {
	test("initialize advertises supports_run_steer", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						runStream: async function* () {},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "init-1",
				method: "initialize",
				params: {
					client: { name: "test-ui", version: "0.0.1" },
					protocol_version: "0",
				},
			} satisfies RpcRequest);

			const resp = await capture.waitForResponse("init-1");
			const result = resp.result as InitializeResult;
			expect(result.server_capabilities?.supports_run_steer).toBe(true);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.steer rejects idle run, mismatched run_id, and empty input", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			let releaseRun!: () => void;
			const runGate = new Promise<void>((resolve) => {
				releaseRun = resolve;
			});

			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						runStream: async function* () {
							await runGate;
							yield { type: "final", content: "done" };
						},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-idle",
				method: "run.steer",
				params: {
					run_id: "run-none",
					input: { type: "text", text: "hi" },
				},
			} satisfies RpcRequest);
			const idleResp = await capture.waitForResponse("steer-idle");
			expect(idleResp.error?.code).toBe(RPC_ERROR_CODE.RUN_NOT_FOUND);

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-1",
				method: "run.start",
				params: { input: { type: "text", text: "initial" } },
			} satisfies RpcRequest);
			const startResp = await capture.waitForResponse("run-1");
			const runId = (startResp.result as RunStartResult).run_id;
			await capture.waitForRunStatus(runId, "running");

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-wrong-run",
				method: "run.steer",
				params: {
					run_id: `${runId}-other`,
					input: { type: "text", text: "hi" },
				},
			} satisfies RpcRequest);
			const wrongResp = await capture.waitForResponse("steer-wrong-run");
			expect(wrongResp.error?.code).toBe(RPC_ERROR_CODE.RUN_NOT_FOUND);

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-empty",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "   " },
				},
			} satisfies RpcRequest);
			const emptyResp = await capture.waitForResponse("steer-empty");
			expect(emptyResp.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);

			releaseRun();
			await capture.waitForRunStatus(runId, "completed");
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	async function runWithUnconsumedSteers(status: "completed" | "cancelled") {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.nextRunId = () => "run-1";
			let releaseFirstPoll!: () => void;
			const firstPollGate = new Promise<void>((resolve) => {
				releaseFirstPoll = resolve;
			});
			let releaseBeforeEnd!: () => void;
			const beforeEndGate = new Promise<void>((resolve) => {
				releaseBeforeEnd = resolve;
			});
			const observedPolls: PolledMessage[] = [];

			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						runStream: async function* (
							_input: unknown,
							options?: { pollMessages?: () => Promise<PolledMessage[]> },
						): AsyncGenerator<AgentEvent> {
							await firstPollGate;
							const firstPolled = (await options?.pollMessages?.()) ?? [];
							observedPolls.push(...firstPolled);
							for (const entry of firstPolled) {
								if (typeof entry !== "string" && entry.kind === "steer") {
									yield {
										type: "steer_applied",
										steer_id: entry.steer_id ?? "",
										content: entry.content,
										timestamp: 1_700_000_000_000,
									};
								}
							}
							await beforeEndGate;
							yield { type: "final", content: "finished" };
						},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-1",
				method: "run.start",
				params: { input: { type: "text", text: "go" } },
			} satisfies RpcRequest);
			const runId = (
				(await capture.waitForResponse("start-1")).result as RunStartResult
			).run_id;
			await capture.waitForRunStatus(runId, "running");

			const sendFirstSteer = (id: string, text: string) =>
				handlers.processMessage({
					jsonrpc: "2.0",
					id,
					method: "run.steer",
					params: {
						run_id: runId,
						input: { type: "text", text },
						client_steer_id: "c-1",
					},
				} satisfies RpcRequest);
			sendFirstSteer("steer-consumed", "focus on tests");
			sendFirstSteer("steer-duplicate-pending", "ignore retry payload");
			const accepted = { ok: true, steer_id: "s1", client_steer_id: "c-1" };
			expect((await capture.waitForResponse("steer-consumed")).result).toEqual(
				accepted,
			);
			expect(
				(await capture.waitForResponse("steer-duplicate-pending")).result,
			).toEqual(accepted);

			releaseFirstPoll();
			await waitFor(() =>
				capture.messages.some(
					(msg) =>
						isRpcNotification(msg) &&
						msg.method === "agent.event" &&
						(msg.params as { event?: { type?: string } } | undefined)?.event
							?.type === "steer_applied",
				),
			);

			sendFirstSteer("steer-duplicate-applied", "ignore retry payload");
			expect(
				(await capture.waitForResponse("steer-duplicate-applied")).result,
			).toEqual(accepted);

			// Enqueue two steers after the last poll so they remain unconsumed at the terminal status.
			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-unconsumed-1",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "follow up 1" },
					client_steer_id: "c-2",
				},
			} satisfies RpcRequest);
			const steerResp2 = await capture.waitForResponse("steer-unconsumed-1");
			const steerResult2 = steerResp2.result as RunSteerResult;
			expect(steerResult2.steer_id).toBe("s2");

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-unconsumed-2",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "follow up 2" },
				},
			} satisfies RpcRequest);
			const steerResp3 = await capture.waitForResponse("steer-unconsumed-2");
			const steerResult3 = steerResp3.result as RunSteerResult;
			expect(steerResult3).toEqual({ ok: true, steer_id: "s3" });

			if (status === "cancelled") {
				await handlers.processMessage({
					jsonrpc: "2.0",
					id: "cancel",
					method: "run.cancel",
					params: { run_id: runId },
				} satisfies RpcRequest);
				expect((await capture.waitForResponse("cancel")).result).toEqual({
					ok: true,
				});
			}
			releaseBeforeEnd();
			const terminal = await capture.waitForRunStatus(runId, status);
			await waitFor(() => !state.activeRunId);

			expect(observedPolls).toEqual([
				{ kind: "steer", steer_id: "s1", content: "focus on tests" },
			]);
			expect(terminal.unconsumed_steer_ids).toEqual(["s2", "s3"]);
			expect(terminal.unconsumed_client_steer_ids).toEqual(["c-2"]);
			const applied = capture.messages
				.filter(isRpcNotification)
				.filter((msg) => msg.method === "agent.event")
				.map((msg) => (msg.params as { event: AgentEvent }).event)
				.filter((event) => event.type === "steer_applied");
			expect(applied).toEqual([
				{
					type: "steer_applied",
					steer_id: "s1",
					client_steer_id: "c-1",
					content: "focus on tests",
					timestamp: 1_700_000_000_000,
				},
			]);
			expect(state.acceptedRunSteerId(runId, "c-1")).toBeUndefined();
			if (status === "cancelled") {
				const trace = capture.messages.filter(
					(message) =>
						isRpcNotification(message) &&
						(message.method === "run.status" ||
							message.method === "agent.event"),
				);
				const fixture = new URL(
					"../../protocol/tests/fixtures/steer-cancel.jsonl",
					import.meta.url,
				);
				if (process.env.CODELIA_UPDATE_STEER_FIXTURE === "1") {
					await fs.writeFile(
						fixture,
						trace.map((message) => JSON.stringify(message)).join("\n") + "\n",
					);
				}
				const lines = (await fs.readFile(fixture, "utf8"))
					.trimEnd()
					.split("\n");
				expect(trace).toEqual(lines.map((line) => JSON.parse(line)));
			}

			// Drain cleared the runtime queue cleanly.
			expect(state.drainRunSteers(runId)).toEqual([]);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	}
	test("live run.steer deduplicates pending and applied input and identifies unconsumed steers", () =>
		runWithUnconsumedSteers("completed"));

	test("run.cancel emits the shared Steer notification trace", () =>
		runWithUnconsumedSteers("cancelled"));

	test("run.steer preserves RPC arrival order even when earlier image preparation awaits", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			let releaseImagePrep!: () => void;
			const imagePrepGate = new Promise<void>((resolve) => {
				releaseImagePrep = resolve;
			});
			let imagePrepStarted = false;
			state.prepareRunImages = async (input) => {
				if (Array.isArray(input)) {
					imagePrepStarted = true;
					await imagePrepGate;
				}
				return input;
			};

			let releasePoll!: () => void;
			const pollGate = new Promise<void>((resolve) => {
				releasePoll = resolve;
			});
			const observedPolls: PolledMessage[] = [];

			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						runStream: async function* (
							_input: unknown,
							options?: { pollMessages?: () => Promise<PolledMessage[]> },
						): AsyncGenerator<AgentEvent> {
							await pollGate;
							const polled = (await options?.pollMessages?.()) ?? [];
							observedPolls.push(...polled);
							yield { type: "final", content: "done" };
						},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-order",
				method: "run.start",
				params: { input: { type: "text", text: "go" } },
			} satisfies RpcRequest);
			const runId = (
				(await capture.waitForResponse("start-order")).result as RunStartResult
			).run_id;
			await capture.waitForRunStatus(runId, "running");

			// Dispatch image steer first (stalled in prepareRunImages), then plain-text steer without awaiting.
			const firstSteerPromise = handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-image",
				method: "run.steer",
				params: {
					run_id: runId,
					input: {
						type: "parts",
						parts: [
							{ type: "text", text: "look at this" },
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,AAAA" },
							},
						],
					},
					client_steer_id: "cs-1",
				},
			} satisfies RpcRequest);
			await waitFor(() => imagePrepStarted);

			const secondSteerPromise = handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-text",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "then summarize" },
					client_steer_id: "cs-2",
				},
			} satisfies RpcRequest);

			// Give the event loop a tick; text steer must still wait behind the image steer.
			await Bun.sleep(20);
			expect(
				capture.messages.some(
					(msg) => isRpcResponse(msg) && msg.id === "steer-text",
				),
			).toBe(false);

			releaseImagePrep();
			await Promise.all([firstSteerPromise, secondSteerPromise]);

			const firstResp = (await capture.waitForResponse("steer-image"))
				.result as RunSteerResult;
			const secondResp = (await capture.waitForResponse("steer-text"))
				.result as RunSteerResult;
			expect(firstResp.steer_id).toBe("s1");
			expect(secondResp.steer_id).toBe("s2");

			releasePoll();
			await capture.waitForRunStatus(runId, "completed");

			expect(
				observedPolls.map((entry) =>
					typeof entry === "string" ? entry : entry.steer_id,
				),
			).toEqual(["s1", "s2"]);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.steer during terminal teardown is rejected instead of accepted and dropped", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			let releaseTerminalSave!: () => void;
			const terminalSaveGate = new Promise<void>((resolve) => {
				releaseTerminalSave = resolve;
			});
			let saveCalls = 0;
			let terminalSaveBlocked = false;

			const handlers = createRuntimeHandlers({
				state,
				sessionStateStore: {
					load: async () => null,
					save: async () => {
						saveCalls += 1;
						// 1st save is on "final" event; 2nd save is "terminal" after runStream exits.
						if (saveCalls === 2) {
							terminalSaveBlocked = true;
							await terminalSaveGate;
						}
					},
					list: async () => [],
				},
				getAgent: async () =>
					({
						runStream: async function* (): AsyncGenerator<AgentEvent> {
							yield { type: "final", content: "done" };
						},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-teardown",
				method: "run.start",
				params: { input: { type: "text", text: "go" } },
			} satisfies RpcRequest);
			const runId = (
				(await capture.waitForResponse("start-teardown"))
					.result as RunStartResult
			).run_id;
			await waitFor(() => terminalSaveBlocked);

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-late",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "too late" },
					client_steer_id: "cs-late",
				},
			} satisfies RpcRequest);
			const lateResp = await capture.waitForResponse("steer-late");
			expect(lateResp.error?.code).toBe(RPC_ERROR_CODE.RUN_NOT_FOUND);

			releaseTerminalSave();
			const completedStatus = await capture.waitForRunStatus(
				runId,
				"completed",
			);
			expect(completedStatus.unconsumed_steer_ids).toBeUndefined();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.steer queued before subagentMessages rejection is emitted in unconsumed_steer_ids", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			let releasePoll!: () => void;
			const pollGate = new Promise<void>((resolve) => {
				releasePoll = resolve;
			});
			state.subagentMessages = async () => {
				throw new Error("subagent poll failed");
			};

			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () =>
					({
						runStream: async function* (
							_input: unknown,
							options?: { pollMessages?: () => Promise<PolledMessage[]> },
						): AsyncGenerator<AgentEvent> {
							await pollGate;
							await options?.pollMessages?.();
							yield { type: "final", content: "unreachable" };
						},
						getContextLeftPercent: () => null,
						getUsageSummary: () => ({
							total_calls: 0,
							total_tokens: 0,
							total_input_tokens: 0,
							total_output_tokens: 0,
							total_cached_input_tokens: 0,
							total_cache_creation_tokens: 0,
							by_model: {},
						}),
						getHistoryMessages: () => [] as BaseMessage[],
						replaceHistoryMessages: () => {},
					}) as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-subagent-err",
				method: "run.start",
				params: { input: { type: "text", text: "go" } },
			} satisfies RpcRequest);
			const runId = (
				(await capture.waitForResponse("start-subagent-err"))
					.result as RunStartResult
			).run_id;
			await capture.waitForRunStatus(runId, "running");

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-before-subagent-err",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "keep me if poll throws" },
					client_steer_id: "cs-subagent-err",
				},
			} satisfies RpcRequest);
			const steerResp = (
				await capture.waitForResponse("steer-before-subagent-err")
			).result as RunSteerResult;
			expect(steerResp.steer_id).toBe("s1");

			releasePoll();
			const errorStatus = await capture.waitForRunStatus(runId, "error");
			expect(errorStatus.unconsumed_steer_ids).toEqual(["s1"]);
			expect(state.drainRunSteers(runId)).toEqual([]);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.cancel during appendMessages after polling steer avoids steer_applied and keeps steer unconsumed", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const { Agent: CoreAgent, defineTool } = await import("@codelia/core");
			const { z } = await import("zod");
			const state = new RuntimeState();

			let releaseTool!: () => void;
			const toolGate = new Promise<void>((resolve) => {
				releaseTool = resolve;
			});
			let toolStarted = false;

			let releaseAppend!: () => void;
			const appendGate = new Promise<void>((resolve) => {
				releaseAppend = resolve;
			});
			let steerAppendStarted = false;

			const pingTool = defineTool({
				name: "ping_tool",
				description: "Ping",
				input: z.object({}),
				execute: async () => {
					toolStarted = true;
					await toolGate;
					return "pong";
				},
			});

			let callCount = 0;
			const coreAgent = new CoreAgent({
				llm: {
					provider: "openai",
					model: "mock-cancel-steer",
					async ainvoke() {
						callCount += 1;
						if (callCount === 1) {
							return {
								messages: [
									{
										role: "assistant" as const,
										content: null,
										tool_calls: [
											{
												id: "call-1",
												type: "function" as const,
												function: { name: "ping_tool", arguments: "{}" },
											},
										],
									},
								],
							};
						}
						return {
							messages: [{ role: "assistant" as const, content: "done" }],
						};
					},
				},
				tools: [pingTool],
			});

			const handlers = createRuntimeHandlers({
				state,
				sessionStateStore: {
					load: async () => null,
					save: async () => undefined,
					list: async () => [],
					appendMessages: async (_sessionId, messages) => {
						if (
							messages.some(
								(msg) =>
									msg.role === "user" && msg.content === "cancel me mid-poll",
							)
						) {
							steerAppendStarted = true;
							await appendGate;
						}
					},
				},
				getAgent: async () => coreAgent as unknown as Agent,
				log: () => {},
			});

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-cancel-mid-poll",
				method: "run.start",
				params: { input: { type: "text", text: "go" } },
			} satisfies RpcRequest);
			const runId = (
				(await capture.waitForResponse("start-cancel-mid-poll"))
					.result as RunStartResult
			).run_id;
			await waitFor(() => toolStarted);

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "steer-mid-poll",
				method: "run.steer",
				params: {
					run_id: runId,
					input: { type: "text", text: "cancel me mid-poll" },
					client_steer_id: "cs-cancel-mid",
				},
			} satisfies RpcRequest);
			const steerResp = (await capture.waitForResponse("steer-mid-poll"))
				.result as RunSteerResult;
			expect(steerResp.steer_id).toBe("s1");

			releaseTool();
			await waitFor(() => steerAppendStarted);

			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-mid-poll",
				method: "run.cancel",
				params: { run_id: runId },
			} satisfies RpcRequest);
			await capture.waitForResponse("cancel-mid-poll");

			releaseAppend();
			const cancelledStatus = await capture.waitForRunStatus(
				runId,
				"cancelled",
			);

			expect(cancelledStatus.unconsumed_steer_ids).toEqual(["s1"]);
			expect(
				capture.messages.some(
					(msg) =>
						isRpcNotification(msg) &&
						msg.method === "agent.event" &&
						(msg.params as { event?: { type?: string } } | undefined)?.event
							?.type === "steer_applied",
				),
			).toBe(false);
			expect(
				coreAgent
					.getHistoryMessages()
					.some(
						(msg) =>
							msg.role === "user" && msg.content === "cancel me mid-poll",
					),
			).toBe(false);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});
});
