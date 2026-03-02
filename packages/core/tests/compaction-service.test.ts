import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "../src/llm/base";
import { toResponsesInput } from "../src/llm/openai/serializer";
import { createModelRegistry } from "../src/models/registry";
import { CompactionService } from "../src/services/compaction/service";
import type { BaseMessage } from "../src/types/llm";
import type {
	ChatInvokeCompletion,
	ChatInvokeUsage,
} from "../src/types/llm/invoke";

const COMPACTION_RETAIN_PREFIX = "[codelia.compaction.retain]\n";
const COMPACTION_SUMMARY_PREFIX = "[codelia.compaction.summary]\n";

const createMockModel = (model: string): BaseChatModel => ({
	provider: "openai",
	model,
	ainvoke: async (): Promise<ChatInvokeCompletion> => {
		throw new Error("not used in this test");
	},
});

describe("CompactionService", () => {
	test("shouldCompact prefers maxInputTokens over contextWindow", async () => {
		const modelRegistry = createModelRegistry([
			{
				id: "gpt-5.2",
				provider: "openai",
				contextWindow: 2000,
				maxInputTokens: 1000,
			},
		]);
		const service = new CompactionService(
			{ enabled: true, auto: true, thresholdRatio: 0.8 },
			{ modelRegistry },
		);
		const llm = createMockModel("gpt-5.2");
		const usage: ChatInvokeUsage = {
			model: "gpt-5.2",
			input_tokens: 120,
			output_tokens: 730,
			total_tokens: 850,
		};

		await expect(service.shouldCompact(llm, usage)).resolves.toBe(true);
	});

	test("shouldCompact falls back from dated usage model to base model context limit", async () => {
		const modelRegistry = createModelRegistry([
			{ id: "gpt-5.2", provider: "openai", contextWindow: 1000 },
		]);
		const service = new CompactionService(
			{ enabled: true, auto: true, thresholdRatio: 0.8 },
			{ modelRegistry },
		);
		const llm = createMockModel("gpt-5.2");
		const usage: ChatInvokeUsage = {
			model: "gpt-5.2-2025-12-11",
			input_tokens: 100,
			output_tokens: 700,
			total_tokens: 800,
		};

		await expect(service.shouldCompact(llm, usage)).resolves.toBe(true);
	});

	test("shouldCompact resolves provider-qualified model ids", async () => {
		const modelRegistry = createModelRegistry([
			{
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				contextWindow: 1000,
			},
		]);
		const service = new CompactionService(
			{ enabled: true, auto: true, thresholdRatio: 0.8 },
			{ modelRegistry },
		);
		const llm = createMockModel("anthropic/claude-sonnet-4-5");
		const usage: ChatInvokeUsage = {
			model: "anthropic/claude-sonnet-4-5",
			input_tokens: 100,
			output_tokens: 700,
			total_tokens: 800,
		};

		await expect(service.shouldCompact(llm, usage)).resolves.toBe(true);
	});

	test("shouldCompact returns false when context limit cannot be resolved", async () => {
		const modelRegistry = createModelRegistry([]);
		const service = new CompactionService(
			{ enabled: true, auto: true, thresholdRatio: 0.8 },
			{ modelRegistry },
		);
		const llm = createMockModel("unknown-model");
		const usage: ChatInvokeUsage = {
			model: "unknown-model",
			input_tokens: 100,
			output_tokens: 700,
			total_tokens: 800,
		};

		await expect(service.shouldCompact(llm, usage)).resolves.toBe(false);
	});

	test("compact does not resurrect tool history in retained tail", async () => {
		const modelRegistry = createModelRegistry([
			{ id: "gpt-5.3", provider: "openai", contextWindow: 128_000 },
		]);
		const service = new CompactionService(
			{ enabled: true, auto: true, retainLastTurns: 1 },
			{ modelRegistry },
		);
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5.3",
			ainvoke: async (): Promise<ChatInvokeCompletion> => ({
				messages: [
					{
						role: "assistant",
						content: "<summary>short summary</summary>",
					},
				],
				usage: {
					model: "gpt-5.3",
					input_tokens: 100,
					output_tokens: 20,
					total_tokens: 120,
				},
			}),
		};
		const history: BaseMessage[] = [
			{ role: "system", content: "system" },
			{ role: "user", content: "old question" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "new question" },
			{
				role: "assistant",
				content: "I will run tools.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo hi"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "bash",
				content: "hi",
			},
			{
				role: "reasoning",
				content: "thinking",
				raw_item: { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
			},
			{ role: "assistant", content: "done" },
		];

		const result = await service.compact(llm, history);
		expect(result.compacted).toBe(true);
		expect(
			result.compactedMessages.some((message) => message.role === "tool"),
		).toBe(false);
		expect(
			result.compactedMessages.some((message) => message.role === "reasoning"),
		).toBe(false);
		const assistantWithToolCalls = result.compactedMessages.find(
			(message) => message.role === "assistant" && Boolean(message.tool_calls),
		);
		expect(assistantWithToolCalls).toBeUndefined();

		const input = toResponsesInput(result.compactedMessages);
		expect(
			input.some(
				(item) =>
					item.type === "function_call" || item.type === "function_call_output",
			),
		).toBe(false);
	});

	test("compact preserves prior retain memory across repeated compactions", async () => {
		const modelRegistry = createModelRegistry([
			{ id: "gpt-5.3", provider: "openai", contextWindow: 128_000 },
		]);
		const requests: BaseMessage[][] = [];
		let invokeCount = 0;
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5.3",
			ainvoke: async (
				input: Parameters<BaseChatModel["ainvoke"]>[0],
			): Promise<ChatInvokeCompletion> => {
				requests.push(input.messages);
				invokeCount += 1;
				if (invokeCount === 1) {
					return {
						messages: [
							{
								role: "assistant",
								content:
									"<retain>must-keep-a</retain><summary>summary-a</summary>",
							},
						],
						usage: {
							model: "gpt-5.3",
							input_tokens: 10,
							output_tokens: 10,
							total_tokens: 20,
						},
					};
				}
				return {
					messages: [
						{
							role: "assistant",
							content:
								"<retain>must-keep-b</retain><summary>summary-b</summary>",
						},
					],
					usage: {
						model: "gpt-5.3",
						input_tokens: 10,
						output_tokens: 10,
						total_tokens: 20,
					},
				};
			},
		};
		const service = new CompactionService(
			{ enabled: true, auto: true, retainLastTurns: 1 },
			{ modelRegistry },
		);

		const first = await service.compact(llm, [
			{ role: "system", content: "system" },
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a1" },
		]);
		const secondInput: BaseMessage[] = [
			...first.compactedMessages,
			{ role: "user", content: "u2" },
			{ role: "assistant", content: "a2" },
		];
		const second = await service.compact(llm, secondInput);

		const retainMemory = second.compactedMessages.find(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.startsWith(COMPACTION_RETAIN_PREFIX),
		);
		expect(retainMemory).toBeDefined();
		expect(
			(retainMemory as Extract<BaseMessage, { role: "user" }>).content,
		).toContain("must-keep-a");
		expect(
			(retainMemory as Extract<BaseMessage, { role: "user" }>).content,
		).toContain("must-keep-b");

		const summaryMemory = second.compactedMessages.find(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				message.content.startsWith(COMPACTION_SUMMARY_PREFIX),
		);
		expect(summaryMemory).toBeDefined();
		expect(
			(summaryMemory as Extract<BaseMessage, { role: "user" }>).content,
		).toContain("summary-b");

		const secondRequest = requests[1] ?? [];
		const hasCompactionMemoryInSecondRequest = secondRequest.some(
			(message) =>
				message.role === "user" &&
				typeof message.content === "string" &&
				(message.content.startsWith(COMPACTION_RETAIN_PREFIX) ||
					message.content.startsWith(COMPACTION_SUMMARY_PREFIX)),
		);
		expect(hasCompactionMemoryInSecondRequest).toBe(false);
	});

	test("compact returns unchanged history when filtered summary input is empty", async () => {
		const modelRegistry = createModelRegistry([
			{ id: "gpt-5.3", provider: "openai", contextWindow: 128_000 },
		]);
		let invoked = false;
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5.3",
			ainvoke: async (): Promise<ChatInvokeCompletion> => {
				invoked = true;
				return {
					messages: [
						{ role: "assistant", content: "<summary>unused</summary>" },
					],
					usage: {
						model: "gpt-5.3",
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
					},
				};
			},
		};
		const service = new CompactionService(
			{ enabled: true, auto: true, retainLastTurns: 1 },
			{ modelRegistry },
		);
		const history: BaseMessage[] = [
			{ role: "user", content: `${COMPACTION_RETAIN_PREFIX}keep` },
			{ role: "user", content: `${COMPACTION_SUMMARY_PREFIX}summary` },
		];

		const result = await service.compact(llm, history);

		expect(invoked).toBe(false);
		expect(result).toEqual({
			compacted: false,
			compactedMessages: history,
			usage: null,
		});
	});
});
