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

	test("still throws in strict mode when model is unknown to both metadata and default registry", async () => {
		await expect(
			buildModelRegistry(buildLlm("openai", "openai/not-a-real-model"), {
				strict: true,
				metadataService: buildMetadataService({ openai: {} }),
			}),
		).rejects.toThrow(
			"Model metadata not found for openai/openai/not-a-real-model after refresh",
		);
	});
});
