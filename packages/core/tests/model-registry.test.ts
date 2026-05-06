import { describe, expect, test } from "bun:test";
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS } from "../src/models/openai";
import {
	applyModelMetadata,
	createModelRegistry,
	type ModelSpec,
	resolveModel,
	resolveProviderModelId,
	supportsFastMode,
} from "../src/models/registry";

describe("resolveProviderModelId", () => {
	test("resolves OpenAI default alias to GPT-5.5", () => {
		const registry = createModelRegistry(OPENAI_MODELS);

		expect(OPENAI_DEFAULT_MODEL).toBe("gpt-5.5");
		expect(resolveModel(registry, "default", "openai")?.id).toBe("gpt-5.5");
	});

	test("returns provider model ids for synthetic model entries", () => {
		const registry = createModelRegistry([
			{
				id: "gpt-5.4-1M",
				provider: "openai",
				providerModelId: "gpt-5.4",
				aliases: ["gpt-5.4-1m", "gpt-5.4-full"],
			},
		] satisfies ModelSpec[]);

		expect(resolveProviderModelId(registry, "gpt-5.4-1M", "openai")).toBe(
			"gpt-5.4",
		);
		expect(resolveProviderModelId(registry, "gpt-5.4-full", "openai")).toBe(
			"gpt-5.4",
		);
	});

	test("falls back to the registry id when no provider model id is set", () => {
		const registry = createModelRegistry([
			{
				id: "gpt-5.4",
				provider: "openai",
			},
		] satisfies ModelSpec[]);

		expect(resolveProviderModelId(registry, "gpt-5.4", "openai")).toBe(
			"gpt-5.4",
		);
	});

	test("applies fast capability from model metadata", () => {
		const registry = applyModelMetadata(
			createModelRegistry([
				{
					id: "gpt-dynamic",
					provider: "openai",
					contextWindow: 128_000,
				},
			] satisfies ModelSpec[]),
			{
				models: {
					openai: {
						"gpt-dynamic": {
							provider: "openai",
							modelId: "gpt-dynamic",
							capabilities: { supportsFast: true },
						},
					},
				},
			},
		);

		expect(supportsFastMode(registry, "gpt-dynamic", "openai")).toBe(true);
	});
});
