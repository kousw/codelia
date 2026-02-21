import { describe, expect, test } from "bun:test";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	RunEventStoreFactory,
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
	for (const callId of toolOutputCallIds) {
		if (!assistantCallIds.has(callId)) {
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
		async waitForRunStatus(
			runId: string,
			status: RunStatusNotify["status"],
		): Promise<void> {
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

const createNoopRunEventStoreFactory = (): RunEventStoreFactory => ({
	create: () => ({
		append: async () => undefined,
	}),
});

const createRejectDanglingHistoryAgent = (): Agent => {
	let messages: BaseMessage[] = [];
	const runStream = async function* (
		input: string,
	): AsyncGenerator<AgentEvent> {
		if (hasDanglingToolCalls(messages)) {
			throw new Error("No tool output found for function call restore_call_1.");
		}
		messages.push({ role: "user", content: input });
		messages.push({ role: "assistant", content: "ok" });
		yield { type: "final", content: "ok" };
	};
	const mock = {
		runStream,
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
		getHistoryMessages: () => messages,
		replaceHistoryMessages: (next: BaseMessage[]) => {
			messages = next;
		},
	};
	return mock as unknown as Agent;
};

const createDanglingProducerAgent = (): Agent => {
	let messages: BaseMessage[] = [];
	const callId = "save_call_1";
	const runStream = async function* (
		input: string,
	): AsyncGenerator<AgentEvent> {
		messages.push({ role: "user", content: input });
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
		yield {
			type: "step_start",
			step_id: callId,
			title: "bash",
			step_number: 1,
		};
		await Bun.sleep(20);
		yield { type: "final", content: "done" };
	};
	const mock = {
		runStream,
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
		getHistoryMessages: () => messages,
		replaceHistoryMessages: (next: BaseMessage[]) => {
			messages = next;
		},
	};
	return mock as unknown as Agent;
};

describe("session state normalization", () => {
	test("restored session state heals dangling tool call history before run", async () => {
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const savedStates: SessionState[] = [];
			const sessionStateStore: SessionStateStore = {
				load: async (sessionId: string) => {
					if (sessionId !== "restore-session") return null;
					return {
						schema_version: 1,
						session_id: sessionId,
						updated_at: "2026-02-15T00:00:00.000Z",
						run_id: "restore-run",
						messages: [
							{ role: "user", content: "first" },
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "restore_call_1",
										type: "function",
										function: {
											name: "bash",
											arguments: '{"command":"echo hi"}',
										},
									},
								],
							},
						],
					};
				},
				save: async (snapshot: SessionState) => {
					savedStates.push(snapshot);
				},
				list: async () => [],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => createRejectDanglingHistoryAgent(),
				log: () => {},
				sessionStateStore,
				runEventStoreFactory: createNoopRunEventStoreFactory(),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "restore-start-1",
				method: "run.start",
				params: {
					session_id: "restore-session",
					input: { type: "text", text: "next" },
				},
			} satisfies RpcRequest);

			const start = await capture.waitForResponse("restore-start-1");
			expect(start.error).toBeUndefined();
			const runId = (start.result as RunStartResult).run_id;
			expect(typeof runId).toBe("string");
			await capture.waitForRunStatus(runId, "completed");

			expect(savedStates.length).toBeGreaterThan(0);
			for (const snapshot of savedStates) {
				expect(hasDanglingToolCalls(snapshot.messages)).toBe(false);
			}
		} finally {
			capture.stop();
		}
	});

	test("session state save drops dangling tool call snapshots", async () => {
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const savedStates: SessionState[] = [];
			const sessionStateStore: SessionStateStore = {
				load: async () => null,
				save: async (snapshot: SessionState) => {
					savedStates.push(snapshot);
				},
				list: async () => [],
			};
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => createDanglingProducerAgent(),
				log: () => {},
				sessionStateStore,
				runEventStoreFactory: createNoopRunEventStoreFactory(),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "save-start-1",
				method: "run.start",
				params: { input: { type: "text", text: "save" } },
			} satisfies RpcRequest);

			const start = await capture.waitForResponse("save-start-1");
			expect(start.error).toBeUndefined();
			const runId = (start.result as RunStartResult).run_id;
			expect(typeof runId).toBe("string");
			await capture.waitForRunStatus(runId, "completed");

			expect(savedStates.length).toBeGreaterThan(0);
			for (const snapshot of savedStates) {
				expect(hasDanglingToolCalls(snapshot.messages)).toBe(false);
			}
		} finally {
			capture.stop();
		}
	});
});
