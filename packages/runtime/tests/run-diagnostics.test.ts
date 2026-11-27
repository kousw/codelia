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
	AgentEventNotify,
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunMetricsNotify,
	RunStartResult,
	RunStatusNotify,
	RunSummaryNotify,
	TelemetryGetResult,
} from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { refreshAccessToken } from "../src/auth/openai-oauth";
import { createRuntimeModel } from "../src/model-factory";
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

const defaultProviderMeta = {
	transport: "http_stream",
	websocket_mode: "off",
	response_id: "mock_resp_1",
	reasoning_requested: "xhigh",
	reasoning_applied: "high",
	reasoning_fallback: true,
};

class MockChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock-model";

	constructor(
		private readonly providerMeta: Record<
			string,
			unknown
		> = defaultProviderMeta,
	) {}

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
			timing: { time_to_first_token_ms: 10_000, generation_duration_ms: 2_000 },
			stop_reason: "end_turn",
			provider_meta: this.providerMeta,
		};
	}
}

const createStores = (
	records: SessionRecord[],
	options: { sessionLogPath?: string } = {},
): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: {
		create: () => ({
			...(options.sessionLogPath ? { filePath: options.sessionLogPath } : {}),
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

describe("always-on run telemetry and telemetry.get", () => {
	test("returns session log path and emits always-on structured run.metrics and run.summary without persisting telemetry records", async () => {
		const llm = new MockChatModel();
		const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
		const records: SessionRecord[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores(records, {
				sessionLogPath: "/tmp/codelia-session.jsonl",
			});
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-session-log",
				method: "run.start",
				params: {
					input: { type: "text", text: "hello" },
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-session-log");
			if (response.error) {
				throw new Error(`run.start failed: ${response.error.message}`);
			}
			const result = response.result as RunStartResult | undefined;
			expect(typeof result?.run_id).toBe("string");
			expect(result?.session_log_path).toBe("/tmp/codelia-session.jsonl");
			await capture.waitForRunStatus(result?.run_id ?? "", "completed");
			const metrics = capture.messages.filter(
				(msg): msg is RpcNotification =>
					isRpcNotification(msg) && msg.method === "run.metrics",
			);
			expect(metrics).toHaveLength(1);
			const call = metrics[0].params as RunMetricsNotify;
			expect(call.seq).toBe(1);
			expect(call.output_tokens_per_second).toBe(10);
			expect(call.cache?.hit_state).toBe("hit");
			expect(call.cache?.cache_read_tokens).toBe(60);
			expect(call.usage?.input_cached_tokens).toBe(60);
			expect(call.provider_meta_summary).toContain("transport=http_stream");
			expect(call.provider_meta_summary).toContain("websocket_mode=off");
			expect(call.provider_meta_summary).toContain("reasoning_requested=xhigh");
			expect(call.provider_meta_summary).toContain("reasoning_applied=high");
			expect(call.cost_usd).toBeNull();
			expect(call.cost_basis).toBe("unavailable");

			const summaries = capture.messages.filter(
				(msg): msg is RpcNotification =>
					isRpcNotification(msg) && msg.method === "run.summary",
			);
			expect(summaries).toHaveLength(1);
			const summaryParams = summaries[0].params as RunSummaryNotify;
			expect(summaryParams.run.total_calls).toBe(1);
			expect(summaryParams.run.total_cached_input_tokens).toBe(60);
			expect(summaryParams.run.total_tokens).toBe(140);
			expect(summaryParams.run.cache_hit_calls).toBe(1);
			expect(summaryParams.run.cache_miss_calls).toBe(0);
			expect(summaryParams.session.total_calls).toBe(1);

			expect(
				records.some(
					(record) =>
						(record as { type: string }).type === "run.metrics" ||
						(record as { type: string }).type === "run.summary",
				),
			).toBe(false);
			const persistedResponse = records.find(
				(record) => record.type === "llm.response",
			);
			expect(
				persistedResponse?.type === "llm.response" &&
					persistedResponse.output.timing,
			).toEqual({
				time_to_first_token_ms: 10_000,
				generation_duration_ms: 2_000,
			});
		} finally {
			capture.stop();
		}
	});

	test("telemetry.get returns session totals that survive invalidateAgentCache and runtime perf snapshot", async () => {
		const llm = new MockChatModel();
		const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
		const records: SessionRecord[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.telemetry.recordStartupPhase("sandbox_mode", 4);
			state.telemetry.setAgentInitPhases([{ name: "mcp_tools", duration_ms: 12 }]);
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				...createStores(records),
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "init-telemetry",
				method: "initialize",
				params: { client: { name: "test", version: "1" } },
			} satisfies RpcRequest);
			const initResp = await capture.waitForResponse("init-telemetry");
			expect(
				(initResp.result as { server_capabilities?: { supports_telemetry?: boolean } })
					?.server_capabilities?.supports_telemetry,
			).toBe(true);

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-telemetry-1",
				method: "run.start",
				params: { input: { type: "text", text: "hello" } },
			} satisfies RpcRequest);
			const runResp = await capture.waitForResponse("run-telemetry-1");
			const runResult = runResp.result as RunStartResult;
			await capture.waitForRunStatus(runResult.run_id, "completed");

			// Simulate model.set / config.set invalidating the cached agent mid-session.
			state.invalidateAgentCache();

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "telemetry-pull",
				method: "telemetry.get",
				params: {},
			} satisfies RpcRequest);
			const telResp = await capture.waitForResponse("telemetry-pull");
			expect(telResp.error).toBeUndefined();
			const snap = telResp.result as TelemetryGetResult;
			expect(snap.session_id).toBe(runResult.session_id);
			expect(snap.active_run_id).toBeNull();
			expect(snap.session_summary.total_calls).toBe(1);
			expect(snap.session_summary.total_cached_input_tokens).toBe(60);
			expect(snap.recent_calls).toHaveLength(1);
			expect(snap.runtime.startup_phases).toEqual([
				{ name: "sandbox_mode", duration_ms: 4 },
			]);
			expect(snap.runtime.agent_init_phases).toEqual([
				{ name: "mcp_tools", duration_ms: 12 },
			]);
			expect(snap.runtime.memory.rss_bytes).toBeGreaterThan(0);
		} finally {
			capture.stop();
		}
	});

	test("emits a visible warning once when openai auto websocket falls back to http", async () => {
		const llm = new MockChatModel({
			transport: "http_stream",
			websocket_mode: "auto",
			fallback_used: true,
			response_id: "mock_resp_auto_1",
		});
		const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
		const records: SessionRecord[] = [];
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores(records);
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-2",
				method: "run.start",
				params: {
					input: { type: "text", text: "hello" },
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-2");
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

		const warningEvents = capture.messages.filter(
			(msg): msg is RpcNotification => {
				if (!isRpcNotification(msg) || msg.method !== "agent.event") {
					return false;
				}
				const params = msg.params as AgentEventNotify | undefined;
				const event = params?.event;
				if (!event || event.type !== "text") {
					return false;
				}
				return (
					event.content ===
					"Warning: OpenAI websocket auto mode fell back to HTTP. Continuing this run over HTTP."
				);
			},
		);
		expect(warningEvents).toHaveLength(1);
	});
});

test("failed runs send safe context even with diagnostics disabled; no raw cause is persisted", async () => {
	const { ProviderFailureError } = await import("@codelia/core");
	const error = new ProviderFailureError(
		{
			provider: "google",
			kind: "provider",
			retryable: false,
			safeMessage: "Google request failed.",
			code: "response_invalid_step_index",
			detail: "The response stream contained an invalid step index.",
		},
		{ attempts: 1, maxAttempts: 3, cause: new Error("api_key=private-cause") },
	);
	const agent = {
		async *runStream() {
			yield {
				type: "text",
				content: "Progress before the failure.",
				timestamp: 1,
			};
			throw error;
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
		getHistoryMessages: () => [],
		replaceHistoryMessages: () => {},
	} as unknown as Agent;
	const records: SessionRecord[] = [];
	const capture = createStdoutCapture();
	capture.start();
	try {
		const state = new RuntimeState();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => agent,
			log: () => {},
			...createStores(records),
		});
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "failure",
			method: "run.start",
			params: { input: { type: "text", text: "hi" } },
		});
		const response = await capture.waitForResponse("failure");
		expect(response.error).toBeUndefined();
		const result = response.result as RunStartResult;
		await capture.waitForRunStatus(result.run_id, "error");
	} finally {
		capture.stop();
	}
	const failed = capture.messages.find(
		(message): message is RpcNotification =>
			isRpcNotification(message) &&
			message.method === "run.status" &&
			(message.params as RunStatusNotify).status === "error",
	);
	if (!failed) throw new Error("expected failed run status");
	expect((failed.params as RunStatusNotify).error).toMatchObject({
		provider: "google",
		code: "response_invalid_step_index",
		attempts: 1,
		detail: expect.stringContaining("step index"),
		hint: expect.stringContaining("/errors show"),
	});
	expect(JSON.stringify(records)).not.toContain("private-cause");
	expect(
		capture.messages.filter(
			(message) =>
				isRpcNotification(message) && message.method === "run.metrics",
		),
	).toHaveLength(0);
});

test("OAuth refresh rejection survives the real SDK, Agent and runtime status/persistence boundary", async () => {
	const originalFetch = globalThis.fetch;
	let tokenRequests = 0;
	let modelRequests = 0;
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			if (String(input) === "https://auth.openai.com/oauth/token") {
				tokenRequests++;
				return Response.json(
					{
						error: {
							code: "refresh_token_expired",
							message: "secret-provider-body",
						},
					},
					{ status: 401 },
				);
			}
			modelRequests++;
			throw new Error("Unexpected model request");
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	const records: SessionRecord[] = [];
	const capture = createStdoutCapture();
	try {
		const { llm } = await createRuntimeModel({
			provider: "openai",
			config: {
				name: "gpt-6.1-terra",
				reasoning: "max",
				experimental: { openai: { websocket_mode: "off" } },
			},
			auth: {
				method: "oauth",
				oauth: {
					access_token: "secret-access-token",
					refresh_token: "secret-refresh-token",
					expires_at: 0,
				},
			},
			useMetadata: false,
			log: () => {},
			getOpenAiAccessToken: async () => {
				const token = await refreshAccessToken("secret-refresh-token");
				return { token: token.access_token };
			},
		});
		const agent = new CoreAgent({
			llm,
			tools: [],
			compaction: null,
			toolOutputCache: null,
		});
		capture.start();
		const handlers = createRuntimeHandlers({
			state: new RuntimeState(),
			getAgent: async () => agent,
			log: () => {},
			...createStores(records),
		});
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "oauth-failure",
			method: "run.start",
			params: { input: { type: "text", text: "Reply OK." } },
		});
		const response = await capture.waitForResponse("oauth-failure");
		expect(response.error).toBeUndefined();
		await capture.waitForRunStatus(
			(response.result as RunStartResult).run_id,
			"error",
		);
	} finally {
		capture.stop();
		globalThis.fetch = originalFetch;
	}
	const failed = capture.messages.find(
		(message): message is RpcNotification =>
			isRpcNotification(message) &&
			message.method === "run.status" &&
			(message.params as RunStatusNotify).status === "error",
	);
	const expected = {
		provider: "openai",
		kind: "auth",
		status: 401,
		code: "oauth_refresh_refresh_token_expired",
		attempts: 1,
		detail: expect.stringContaining("refresh token has expired"),
		hint: expect.stringContaining("sign in again"),
	};
	expect((failed?.params as RunStatusNotify)?.error).toMatchObject(expected);
	expect(records.find((record) => record.type === "run.error")).toMatchObject({
		error: expected,
	});
	expect(tokenRequests).toBe(1);
	expect(modelRequests).toBe(0);
	const serialized = JSON.stringify([capture.messages, records]);
	for (const secret of [
		"secret-provider-body",
		"secret-access-token",
		"secret-refresh-token",
	])
		expect(serialized).not.toContain(secret);
});
