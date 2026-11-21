import { describe, expect, test } from "bun:test";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	ContentPart,
	RunEventStoreFactory,
	SessionStateStore,
	Tool,
} from "@codelia/core";
import {
	RPC_ERROR_CODE,
	type RpcMessage,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
	type RunStartResult,
	type RunStatusNotify,
} from "@codelia/protocol";
import { createAgentFactory } from "../src/agent-factory";
import { runtimeEnvironmentPresets } from "../src/environment";
import { isSecuredRuntimeTool } from "../src/permissions/tool-approval";
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
		messages,
		start() {
			process.stdout.write = write;
		},
		stop() {
			process.stdout.write = originalWrite;
		},
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

const createStores = (): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: {
		create: () => ({
			append: () => undefined,
		}),
	},
	sessionStateStore: {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
	},
});

describe("run.start force_compaction", () => {
	test("forwards force_compaction to Agent.runStream options", async () => {
		const observed: Array<{
			input: string | ContentPart[];
			forceCompaction?: boolean;
		}> = [];
		const mockAgent: Agent = {
			runStream: async function* (
				input: string | ContentPart[],
				options?: { forceCompaction?: boolean },
			): AsyncGenerator<AgentEvent> {
				observed.push({
					input,
					forceCompaction: options?.forceCompaction,
				});
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
			replaceHistoryMessages: (_messages: BaseMessage[]) => {},
		} as unknown as Agent;

		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => mockAgent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-1",
				method: "run.start",
				params: {
					input: { type: "text", text: "ignored by /compact" },
					force_compaction: true,
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

		expect(observed).toEqual([
			{ input: "ignored by /compact", forceCompaction: true },
		]);
	});

	test("forwards run.start client tools to Agent.runStream options", async () => {
		const observed: Array<{
			input: string | ContentPart[];
			tools?: Tool[];
			toolChoice?: string;
		}> = [];
		const mockAgent: Agent = {
			runStream: async function* (
				input: string | ContentPart[],
				options?: {
					tools?: Tool[];
					toolChoice?: string;
				},
			): AsyncGenerator<AgentEvent> {
				observed.push({
					input,
					tools: options?.tools,
					toolChoice: options?.toolChoice,
				});
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
			replaceHistoryMessages: (_messages: BaseMessage[]) => {},
		} as unknown as Agent;

		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.setRuntimeEnvironment({
				environment: {
					contract: {
						...runtimeEnvironmentPresets["embedded-no-local-tools"],
						events: { live: "json-rpc" },
					},
				},
				adapters: {
					systemPromptProvider: { loadSystemPrompt: () => "Fixture" },
					configProvider: {
						resolveModelConfig: async () => ({
							provider: "openai",
							name: "gpt-5",
						}),
					},
					credentialProvider: {
						resolveProvider: async () => "openai",
						resolveProviderAuth: async () => ({
							method: "api_key",
							api_key: "fixture-key",
						}),
					},
					toolProviders: [],
				},
			});
			const stores = createStores();
			const getAgent = createAgentFactory(state, {
				sessionStateStore: stores.sessionStateStore,
			});
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => {
					await getAgent();
					return mockAgent;
				},
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-client-tools",
				method: "run.start",
				params: {
					input: { type: "text", text: "inspect" },
					tools: [
						{
							name: "inspect_evidence",
							description: "Inspect evidence",
							parameters: {
								type: "object",
								properties: { target: { type: "string" } },
							},
						},
					],
					tool_choice: "inspect_evidence",
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-client-tools");
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

		expect(observed[0]?.tools?.map((tool) => tool.name)).toEqual([
			"inspect_evidence",
		]);
		expect(observed[0]?.tools?.[0]?.definition.name).toBe("inspect_evidence");
		expect(observed[0]?.toolChoice).toBe("inspect_evidence");
		expect(observed[0]?.tools?.map(isSecuredRuntimeTool)).toEqual([true]);
	});

	test("rejects client tools without a runtime approval registration before starting the run", async () => {
		const captured = createStdoutCapture();
		const state = new RuntimeState();
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => ({}) as Agent,
			log: () => {},
			...createStores(),
		});
		captured.start();
		try {
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "unregistered-run",
				method: "run.start",
				params: {
					input: { type: "text", text: "inspect" },
					tools: [
						{
							name: "inspect_evidence",
							description: "Inspect evidence",
							parameters: {},
						},
					],
				},
			});
			expect(
				(await captured.waitForResponse("unregistered-run")).error?.code,
			).toBe(RPC_ERROR_CODE.RUNTIME_INTERNAL);
			expect(state.activeRunId).toBeNull();
			expect(state.sessionId).toBeNull();
			expect(
				captured.messages.some(
					(message) =>
						"method" in message && message.method === "client.tool.call",
				),
			).toBe(false);
		} finally {
			captured.stop();
		}
	});

	test("injects skill mention list into run input", async () => {
		const observed: Array<{
			input: string | ContentPart[];
			forceCompaction?: boolean;
		}> = [];
		const mockAgent: Agent = {
			runStream: async function* (
				input: string | ContentPart[],
				options?: { forceCompaction?: boolean },
			): AsyncGenerator<AgentEvent> {
				observed.push({
					input,
					forceCompaction: options?.forceCompaction,
				});
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
			replaceHistoryMessages: (_messages: BaseMessage[]) => {},
		} as unknown as Agent;

		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => mockAgent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-mentions",
				method: "run.start",
				params: {
					input: { type: "text", text: "$find-skills ratatui" },
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-mentions");
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

		expect(observed).toHaveLength(1);
		expect(typeof observed[0]?.input).toBe("string");
		const inputText = observed[0]?.input as string;
		expect(inputText).toContain("$find-skills ratatui");
		expect(inputText).toContain("<skill_mentions>");
		expect(inputText).toContain("- find-skills");
		expect(inputText).not.toContain("Skill usage instructions:");
	});

	test("passes text + image parts to Agent.runStream", async () => {
		const observed: Array<string | ContentPart[]> = [];
		const mockAgent: Agent = {
			runStream: async function* (
				input: string | ContentPart[],
			): AsyncGenerator<AgentEvent> {
				observed.push(input);
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
			replaceHistoryMessages: (_messages: BaseMessage[]) => {},
		} as unknown as Agent;

		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => mockAgent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-parts",
				method: "run.start",
				params: {
					input: {
						type: "parts",
						parts: [
							{ type: "text", text: "$find-skills check this" },
							{
								type: "image_url",
								image_url: {
									url: "data:image/png;base64,AAAA",
									media_type: "image/png",
									detail: "auto",
								},
							},
						],
					},
				},
			} satisfies RpcRequest);

			const response = await capture.waitForResponse("run-parts");
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

		expect(observed).toHaveLength(1);
		const runInput = observed[0];
		expect(Array.isArray(runInput)).toBeTrue();
		expect(runInput).toEqual([
			{
				type: "text",
				text: "$find-skills check this\n<skill_mentions>\n- find-skills\n</skill_mentions>",
			},
			{
				type: "image_url",
				image_url: {
					url: "data:image/png;base64,AAAA",
					media_type: "image/png",
					detail: "auto",
				},
			},
		]);
	});

	test("rejects invalid image media type in run.start parts", async () => {
		const mockAgent: Agent = {
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
			replaceHistoryMessages: (_messages: BaseMessage[]) => {},
		} as unknown as Agent;

		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			const stores = createStores();
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => mockAgent,
				log: () => {},
				...stores,
			});

			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-invalid-parts",
				method: "run.start",
				params: {
					input: {
						type: "parts",
						parts: [
							{
								type: "image_url",
								image_url: {
									url: "data:image/png;base64,AAAA",
									media_type: "image/bmp",
								},
							},
						],
					},
				},
			} as RpcRequest);

			const response = await capture.waitForResponse("run-invalid-parts");
			expect(response.error?.code).toBe(RPC_ERROR_CODE.INVALID_PARAMS);
			expect(response.error?.message).toContain("media_type");
		} finally {
			capture.stop();
		}
	});
});

test.each([true, false])(
	"output streaming capability=%s forwards previews without persisting them",
	async (enabled) => {
		let observed: boolean | undefined;
		const stored: unknown[] = [];
		const mockAgent = {
			async *runStream(_input: unknown, options: { streamDeltas?: boolean }) {
				observed = options.streamDeltas === true;
				if (options.streamDeltas) {
					yield {
						type: "text.delta",
						stream_id: "preview",
						index: 0,

						delta: "partial",
					};
				}
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
			getHistoryMessages: () => [],
			replaceHistoryMessages: () => {},
		} as unknown as Agent;
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.setUiCapabilities({ supports_text_delta: enabled });
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => mockAgent,
				log: () => {},
				...createStores(),
				runEventStoreFactory: {
					create: () => ({
						append: (record) => {
							stored.push(record);
						},
					}),
				},
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "stream-test",
				method: "run.start",
				params: { input: { type: "text", text: "hi" } },
			});
			const response = await capture.waitForResponse("stream-test");
			expect(response.error).toBeUndefined();
			const { run_id } = response.result as RunStartResult;
			await capture.waitForRunStatus(run_id, "completed");
			expect(observed).toBe(enabled);
			const streamed = capture.messages.filter(
				(message) =>
					isRpcNotification(message) &&
					message.method === "agent.event" &&
					(message.params as { event: { type: string } }).event.type ===
						"text.delta",
			);
			expect(streamed).toHaveLength(enabled ? 1 : 0);
			expect(JSON.stringify(stored)).not.toContain("text.delta");
			expect(JSON.stringify(stored)).toContain('"type":"final"');
		} finally {
			capture.stop();
		}
	},
);
