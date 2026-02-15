import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	SessionState,
	SessionStateStore,
} from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunStartResult,
	RunStatusNotify,
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
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for condition");
};

const hasDanglingToolCalls = (messages: BaseMessage[]): boolean => {
	const assistantCallIds = new Set<string>();
	const toolOutputCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				assistantCallIds.add(call.id);
			}
			continue;
		}
		if (message.role === "tool") {
			toolOutputCallIds.add(message.tool_call_id);
		}
	}
	for (const callId of assistantCallIds) {
		if (!toolOutputCallIds.has(callId)) {
			return true;
		}
	}
	return false;
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
		async waitForRunStatus(runId: string, status: RunStatusNotify["status"]) {
			await waitFor(() =>
				messages.some((msg): boolean => {
					if (!isRpcNotification(msg)) return false;
					if (msg.method !== "run.status") return false;
					const params = msg.params as RunStatusNotify | undefined;
					return params?.run_id === runId && params?.status === status;
				}),
			);
		},
	};
};

const withTempStorageEnv = async () => {
	const tempRoot = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-cancel-test-"),
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

const createMockAgent = (): Agent => {
	const runStream = async function* (): AsyncGenerator<AgentEvent> {
		await Bun.sleep(120);
		yield {
			type: "text",
			content: "still running",
			timestamp: Date.now(),
		};
		yield { type: "final", content: "done" };
	};

	const mock = {
		runStream,
		getContextLeftPercent: () => null,
		getHistoryMessages: () => [] as BaseMessage[],
		replaceHistoryMessages: (_messages: BaseMessage[]) => {},
	};
	return mock as unknown as Agent;
};

const createHistorySensitiveAgent = (): Agent => {
	let runCount = 0;
	let messages: BaseMessage[] = [];
	const callId = "call_cancel_race_1";

	const runStream = async function* (
		input: string,
	): AsyncGenerator<AgentEvent> {
		runCount += 1;
		messages.push({ role: "user", content: input });
		if (runCount === 1) {
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: callId,
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo hi"}',
						},
					},
				],
			});
			await Bun.sleep(120);
			yield {
				type: "step_start",
				step_id: callId,
				title: "bash",
				step_number: 1,
			};
			return;
		}

		if (hasDanglingToolCalls(messages)) {
			throw new Error(`No tool output found for function call ${callId}.`);
		}

		messages.push({
			role: "assistant",
			content: "ok",
			tool_calls: [],
		});
		yield { type: "final", content: "ok" };
	};

	const mock = {
		runStream,
		getContextLeftPercent: () => null,
		getHistoryMessages: () => messages,
		replaceHistoryMessages: (next: BaseMessage[]) => {
			messages = next;
		},
	};
	return mock as unknown as Agent;
};

const createAbortAwareAgent = (): Agent => {
	const runStream = async function* (
		_input: string,
		options?: { signal?: AbortSignal },
	): AsyncGenerator<AgentEvent> {
		await new Promise<void>((_resolve, reject) => {
			const onAbort = () => {
				const error = new Error("operation aborted");
				error.name = "AbortError";
				reject(error);
			};
			if (options?.signal?.aborted) {
				onAbort();
				return;
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });
		});
		yield { type: "final", content: "unreachable" };
	};

	const mock = {
		runStream,
		getContextLeftPercent: () => null,
		getHistoryMessages: () => [] as BaseMessage[],
		replaceHistoryMessages: (_messages: BaseMessage[]) => {},
	};
	return mock as unknown as Agent;
};

const createDelayedSessionStateStore = (delayMs: number): SessionStateStore => ({
	load: async () => null,
	save: async (_snapshot: SessionState) => {
		if (delayMs > 0) {
			await Bun.sleep(delayMs);
		}
	},
	list: async () => [],
});

const createCancelTerminalRaceAgent = (): Agent => {
	let runCount = 0;
	let messages: BaseMessage[] = [];
	const callId = "call_cancel_terminal_race_1";

	const runStream = async function* (
		input: string,
	): AsyncGenerator<AgentEvent> {
		runCount += 1;
		messages.push({ role: "user", content: input });
		if (runCount === 1) {
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: callId,
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo hi"}',
						},
					},
				],
			});
			return;
		}

		if (hasDanglingToolCalls(messages)) {
			throw new Error(`No tool output found for function call ${callId}.`);
		}

		messages.push({
			role: "assistant",
			content: "ok",
			tool_calls: [],
		});
		yield { type: "final", content: "ok" };
	};

	const mock = {
		runStream,
		getContextLeftPercent: () => null,
		getHistoryMessages: () => messages,
		replaceHistoryMessages: (next: BaseMessage[]) => {
			messages = next;
		},
	};
	return mock as unknown as Agent;
};

describe("run.cancel", () => {
	test("returns cancelled and suppresses later agent events", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => createMockAgent(),
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-1",
				method: "run.start",
				params: { input: { type: "text", text: "hello" } },
			} satisfies RpcRequest);

			const startResponse = await capture.waitForResponse("start-1");
			expect(startResponse.error).toBeUndefined();
			const runId = (startResponse.result as RunStartResult).run_id;
			expect(typeof runId).toBe("string");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-1",
				method: "run.cancel",
				params: { run_id: runId, reason: "test cancel" },
			} satisfies RpcRequest);

			const cancelResponse = await capture.waitForResponse("cancel-1");
			expect(cancelResponse.error).toBeUndefined();
			expect(cancelResponse.result).toEqual({ ok: true });

			await capture.waitForRunStatus(runId, "cancelled");
			await Bun.sleep(220);

			const agentEvents = capture.messages.filter(
				(msg): msg is RpcNotification => {
					if (!isRpcNotification(msg)) return false;
					if (msg.method !== "agent.event") return false;
					const run = (msg.params as { run_id?: string } | undefined)?.run_id;
					return run === runId;
				},
			);
			expect(agentEvents).toHaveLength(0);
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("returns run not found for unknown run_id", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => createMockAgent(),
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-missing",
				method: "run.cancel",
				params: { run_id: "missing-run" },
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("cancel-missing");
			expect(response.error).toBeDefined();
			expect(response.error?.code).toBe(-32002);
			expect(response.error?.message).toBe("run not found");
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("cancelled run does not poison next run with dangling tool call history", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const agent = createHistorySensitiveAgent();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-cancel-1",
				method: "run.start",
				params: { input: { type: "text", text: "first" } },
			} satisfies RpcRequest);
			const start1 = await capture.waitForResponse("start-cancel-1");
			expect(start1.error).toBeUndefined();
			const run1Id = (start1.result as RunStartResult).run_id;

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-cancel-1",
				method: "run.cancel",
				params: { run_id: run1Id, reason: "test cancel race" },
			} satisfies RpcRequest);
			const cancelResponse = await capture.waitForResponse("cancel-cancel-1");
			expect(cancelResponse.error).toBeUndefined();
			expect(cancelResponse.result).toEqual({ ok: true });
			await waitFor(() => state.activeRunId === null);

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-cancel-2",
				method: "run.start",
				params: { input: { type: "text", text: "second" } },
			} satisfies RpcRequest);
			const start2 = await capture.waitForResponse("start-cancel-2");
			expect(start2.error).toBeUndefined();
			expect(start2.result).toBeDefined();
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("run.cancel aborts in-flight run quickly and releases busy state", async () => {
		const env = await withTempStorageEnv();
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const agent = createAbortAwareAgent();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-abort-1",
				method: "run.start",
				params: { input: { type: "text", text: "first" } },
			} satisfies RpcRequest);
			const start1 = await capture.waitForResponse("start-abort-1");
			expect(start1.error).toBeUndefined();
			const run1Id = (start1.result as RunStartResult).run_id;

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-abort-1",
				method: "run.cancel",
				params: { run_id: run1Id, reason: "cancel now" },
			} satisfies RpcRequest);
			const cancel1 = await capture.waitForResponse("cancel-abort-1");
			expect(cancel1.error).toBeUndefined();
			expect(cancel1.result).toEqual({ ok: true });
			await capture.waitForRunStatus(run1Id, "cancelled");
			await waitFor(() => state.activeRunId === null);

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-abort-2",
				method: "run.start",
				params: { input: { type: "text", text: "second" } },
			} satisfies RpcRequest);
			const start2 = await capture.waitForResponse("start-abort-2");
			expect(start2.error).toBeUndefined();
			const run2Id = (start2.result as RunStartResult).run_id;
			expect(typeof run2Id).toBe("string");
		} finally {
			capture.stop();
			await env.cleanup();
		}
	});

	test("cancelled terminal race normalizes in-memory history for next run", async () => {
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const agent = createCancelTerminalRaceAgent();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				sessionStateStore: createDelayedSessionStateStore(80),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-terminal-race-1",
				method: "run.start",
				params: { input: { type: "text", text: "first" } },
			} satisfies RpcRequest);
			const start1 = await capture.waitForResponse("start-terminal-race-1");
			expect(start1.error).toBeUndefined();
			const run1Id = (start1.result as RunStartResult).run_id;
			expect(typeof run1Id).toBe("string");

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-terminal-race-1",
				method: "run.cancel",
				params: { run_id: run1Id, reason: "cancel terminal race" },
			} satisfies RpcRequest);
			const cancel1 = await capture.waitForResponse("cancel-terminal-race-1");
			expect(cancel1.error).toBeUndefined();
			expect(cancel1.result).toEqual({ ok: true });

			await capture.waitForRunStatus(run1Id, "cancelled");
			await waitFor(() => state.activeRunId === null);

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "start-terminal-race-2",
				method: "run.start",
				params: { input: { type: "text", text: "second" } },
			} satisfies RpcRequest);
			const start2 = await capture.waitForResponse("start-terminal-race-2");
			expect(start2.error).toBeUndefined();
			const run2Id = (start2.result as RunStartResult).run_id;
			expect(typeof run2Id).toBe("string");
			await capture.waitForRunStatus(run2Id, "completed");
		} finally {
			capture.stop();
		}
	});
});
