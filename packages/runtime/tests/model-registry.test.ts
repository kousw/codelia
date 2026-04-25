import { describe, expect, test } from "bun:test";
import type { BaseChatModel, ModelEntry } from "@codelia/core";
import { resolveModel } from "@codelia/core";
import { buildModelRegistry } from "../src/model-registry";

const buildLlm = (
	provider: BaseChatModel["provider"],
	model: string,
): BaseChatModel => ({
	provider,
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

describe("buildModelRegistry strict fallback", () => {
	test("keeps static GPT-5.5 capped context when metadata is missing", async () => {
		const registry = await buildModelRegistry(buildLlm("openai", "gpt-5.5"), {
			strict: true,
			metadataService: buildMetadataService({ openai: {} }),
		});

		const spec = resolveModel(registry, "gpt-5.5", "openai");
		expect(spec?.contextWindow).toBe(1_050_000);
		expect(spec?.maxInputTokens).toBe(270_000);
		expect(spec?.maxOutputTokens).toBe(130_000);
	});

	test("resolves GPT-5.5 full-context alias to provider model", async () => {
		const registry = await buildModelRegistry(
			buildLlm("openai", "gpt-5.5-1M"),
			{
				strict: true,
				metadataService: buildMetadataService({ openai: {} }),
			},
		);

		const spec = resolveModel(registry, "gpt-5.5-full", "openai");
		expect(spec?.providerModelId).toBe("gpt-5.5");
		expect(spec?.contextWindow).toBe(1_050_000);
		expect(spec?.maxInputTokens).toBe(920_000);
		expect(spec?.maxOutputTokens).toBe(130_000);
	});

	test("does not throw when metadata is missing but model exists in default registry", async () => {
		const registry = await buildModelRegistry(
			buildLlm("openai", "openai/gpt-5.4"),
			{
				strict: true,
				metadataService: buildMetadataService({ openai: {} }),
			},
		);
		const spec = resolveModel(registry, "gpt-5.4", "openai");
		expect(spec?.provider).toBe("openai");
	});

	test("throws in strict mode when fallback static spec lacks required limits", async () => {
		await expect(
			buildModelRegistry(buildLlm("openai", "gpt-5.5-pro"), {
				strict: true,
				metadataService: buildMetadataService({ openai: {} }),
			}),
		).rejects.toThrow("Usable model metadata not found for openai/gpt-5.5-pro");
	});

	test("still throws in strict mode when model is unknown to both metadata and default registry", async () => {
		await expect(
			buildModelRegistry(buildLlm("openai", "openai/not-a-real-model"), {
				strict: true,
				metadataService: buildMetadataService({ openai: {} }),
			}),
		).rejects.toThrow(
			"Usable model metadata not found for openai/openai/not-a-real-model after refresh",
		);
	});
});
