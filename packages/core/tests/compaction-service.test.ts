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
});
