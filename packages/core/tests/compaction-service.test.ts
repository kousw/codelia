import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "../src/llm/base";
import { createModelRegistry } from "../src/models/registry";
import { CompactionService } from "../src/services/compaction/service";
import type {
	ChatInvokeCompletion,
	ChatInvokeUsage,
} from "../src/types/llm/invoke";

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
});
