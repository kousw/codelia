import { describe, expect, test } from "bun:test";
import type { BaseChatModel, ModelEntry } from "@codelia/core";
import { resolveModel } from "@codelia/core";
import { buildModelRegistry } from "../src/model-registry";

const buildOpenRouterLlm = (model: string): BaseChatModel<"openrouter"> => ({
	provider: "openrouter",
	model,
	ainvoke: async () => ({
		messages: [{ role: "assistant", content: "ok" }],
	}),
});

const buildMetadataService = (
	entries: Record<string, Record<string, ModelEntry>>,
): NonNullable<
	Parameters<typeof buildModelRegistry>[1]
>["metadataService"] => ({
	getAllModelEntries: async () => entries,
	refreshAllModelEntries: async () => entries,
});

describe("buildModelRegistry openrouter dynamic model", () => {
	test("registers current openrouter model from metadata with case-insensitive lookup", async () => {
		const entries: Record<string, Record<string, ModelEntry>> = {
			openrouter: {
				"moonshotai/Kimi-K2.5": {
					provider: "openrouter",
					modelId: "moonshotai/Kimi-K2.5",
					limits: {
						contextWindow: 262_144,
						inputTokens: 262_144,
						outputTokens: 65_535,
					},
				},
			},
		};
		const registry = await buildModelRegistry(
			buildOpenRouterLlm("moonshotai/kimi-k2.5"),
			{
				strict: false,
				metadataService: buildMetadataService(entries),
			},
		);

		const direct = resolveModel(registry, "moonshotai/kimi-k2.5", "openrouter");
		const prefixed = resolveModel(
			registry,
			"openrouter/moonshotai/kimi-k2.5",
			"openrouter",
		);
		expect(direct?.maxInputTokens).toBe(262_144);
		expect(direct?.maxOutputTokens).toBe(65_535);
		expect(prefixed?.id).toBe("moonshotai/kimi-k2.5");
	});
});
