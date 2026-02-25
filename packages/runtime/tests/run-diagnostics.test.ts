import { describe, expect, test } from "bun:test";
import type {
	Agent,
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
	RunEventStoreFactory,
	SessionRecord,
	SessionStateStore,
} from "@codelia/core";
import { Agent as CoreAgent } from "@codelia/core";
import type {
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunDiagnosticsNotify,
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

class MockChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock-model";

	async ainvoke(
		_input: ChatInvokeInput & { options?: unknown },
		_context?: ChatInvokeContext,
	): Promise<Awaited<ReturnType<BaseChatModel["ainvoke"]>>> {
		return {
			messages: [{ role: "assistant" as const, content: "done" }],
			usage: {
				model: "mock-model",
				input_tokens: 120,
				output_tokens: 20,
				total_tokens: 140,
				input_cached_tokens: 60,
				input_cache_creation_tokens: 0,
			},
			stop_reason: "end_turn",
			provider_meta: {
				transport: "http_stream",
				websocket_mode: "off",
				response_id: "mock_resp_1",
			},
		};
	}
}

const createStores = (
	records: SessionRecord[],
): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: {
		create: () => ({
			append: (record) => {
				records.push(record);
			},
		}),
	},
	sessionStateStore: {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
	},
});

describe("run.diagnostics notifications", () => {
	test("emits per-call cache diagnostics and run summary without persisting diagnostics records", async () => {
		const llm = new MockChatModel();
		const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
		const records: SessionRecord[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.diagnosticsEnabled = true;
			const stores = createStores(records);
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-1",
				method: "run.start",
				params: {
					input: { type: "text", text: "hello" },
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-1");
			if (response.error) {
				throw new Error(`run.start failed: ${response.error.message}`);
			}
			const result = response.result as RunStartResult | undefined;
			if (!result?.run_id) {
				throw new Error("run.start did not return run_id");
			}
			await capture.waitForRunStatus(result.run_id, "completed");
		} finally {
			capture.stop();
		}

		const diagnostics = capture.messages.filter(
			(msg): msg is RpcNotification =>
				isRpcNotification(msg) && msg.method === "run.diagnostics",
		);
		expect(diagnostics.length).toBeGreaterThanOrEqual(2);
		const llmCall = diagnostics.find(
			(msg) =>
				(msg.params as RunDiagnosticsNotify | undefined)?.kind === "llm_call",
		);
		expect(llmCall).toBeDefined();
		const llmCallParams = llmCall?.params as RunDiagnosticsNotify;
		if (llmCallParams.kind !== "llm_call") {
			throw new Error("expected llm_call diagnostics");
		}
		expect(llmCallParams.call.cache.hit_state).toBe("hit");
		expect(llmCallParams.call.cache.cache_read_tokens).toBe(60);
		expect(llmCallParams.call.usage?.input_cached_tokens).toBe(60);
		expect(llmCallParams.call.provider_meta_summary).toContain(
			"transport=http_stream",
		);
		expect(llmCallParams.call.provider_meta_summary).toContain(
			"websocket_mode=off",
		);

		const summary = diagnostics.find(
			(msg) =>
				(msg.params as RunDiagnosticsNotify | undefined)?.kind ===
				"run_summary",
		);
		expect(summary).toBeDefined();
		const summaryParams = summary?.params as RunDiagnosticsNotify;
		if (summaryParams.kind !== "run_summary") {
			throw new Error("expected run_summary diagnostics");
		}
		expect(summaryParams.summary.total_calls).toBe(1);
		expect(summaryParams.summary.total_cached_input_tokens).toBe(60);
		expect(summaryParams.summary.total_tokens).toBe(140);

		expect(
			records.some(
				(record) => (record as { type: string }).type === "run.diagnostics",
			),
		).toBe(false);
	});
});
