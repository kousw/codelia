import { describe, expect, test } from "bun:test";
import type {
	Agent,
	AgentEvent,
	BaseMessage,
	ContentPart,
	RunEventStoreFactory,
	SessionStateStore,
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
