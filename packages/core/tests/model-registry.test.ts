import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS } from "../src/models/anthropic";
import { MOONSHOT_MODELS } from "../src/models/moonshot";
import { OPENAI_DEFAULT_MODEL, OPENAI_MODELS } from "../src/models/openai";
import {
	applyModelMetadata,
	createModelRegistry,
	type ModelSpec,
	resolveModel,
	resolveProviderModelId,
	supportsFastMode,
} from "../src/models/registry";
import { XAI_MODELS } from "../src/models/xai";

describe("resolveProviderModelId", () => {
	test("registers Grok 4.5 with xAI limits and aliases", () => {
		const registry = createModelRegistry(XAI_MODELS);
		const spec = resolveModel(registry, "grok-build-latest", "xai");

		expect(spec).toMatchObject({
			id: "grok-4.5",
			provider: "xai",
			contextWindow: 500_000,
			maxInputTokens: 200_000,
			supportsTools: true,
			supportsVision: true,
			supportsReasoning: true,
		});
	});
	test("registers Kimi K3 with Moonshot native limits and capabilities", () => {
		const registry = createModelRegistry(MOONSHOT_MODELS);
		const spec = resolveModel(registry, "default", "moonshot");

		expect(spec).toMatchObject({
			id: "kimi-k3",
			provider: "moonshot",
			contextWindow: 1_048_576,
			maxInputTokens: 1_048_576,
			maxOutputTokens: 1_048_576,
			supportsTools: true,
			supportsVision: true,
			supportsReasoning: true,
		});
	});

	test("registers Claude Fable 5 with published limits", () => {
		const registry = createModelRegistry(ANTHROPIC_MODELS);

		expect(resolveModel(registry, "claude-fable-5", "anthropic")).toEqual({
			id: "claude-fable-5",
			provider: "anthropic",
			contextWindow: 1_000_000,
			maxInputTokens: 1_000_000,
			maxOutputTokens: 128_000,
		});
	});

	test.each([
		["claude-fable-5-1", false],
		["claude-opus-5-5", true],
		["claude-sonnet-5", false],
	] as const)("registers %s with its fast-mode capability", (id, fast) => {
		const registry = createModelRegistry(ANTHROPIC_MODELS);
		expect(resolveModel(registry, id, "anthropic")).toMatchObject({
			id,
			contextWindow: 1_000_000,
			maxInputTokens: 1_000_000,
			maxOutputTokens: 128_000,
		});
		expect(supportsFastMode(registry, id, "anthropic")).toBe(fast);
	});

	test("registers Claude Opus 5 with published limits and fast mode", () => {
		const registry = createModelRegistry(ANTHROPIC_MODELS);

		expect(resolveModel(registry, "claude-opus-5", "anthropic")).toEqual({
			id: "claude-opus-5",
			provider: "anthropic",
			contextWindow: 1_000_000,
			maxInputTokens: 1_000_000,
			maxOutputTokens: 128_000,
			supportsFast: true,
		});
		expect(supportsFastMode(registry, "claude-opus-5", "anthropic")).toBe(true);
	});

	test("uses GPT-5.6 as the OpenAI default without a registry alias", () => {
		const registry = createModelRegistry(OPENAI_MODELS);

		expect(OPENAI_DEFAULT_MODEL).toBe("gpt-5.6");
		expect(resolveModel(registry, "default", "openai")).toBeUndefined();
		expect(resolveModel(registry, "gpt-5.6", "openai")?.maxInputTokens).toBe(
			270_000,
		);
	});

	test("registers only provider ids for the GPT-5.6 family", () => {
		const registry = createModelRegistry(OPENAI_MODELS);

		for (const providerModelId of [
			"gpt-5.6",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]) {
			expect(resolveModel(registry, providerModelId, "openai")).toMatchObject({
				id: providerModelId,
				maxInputTokens: 270_000,
			});
			expect(
				resolveModel(registry, `${providerModelId}-1M`, "openai"),
			).toBeUndefined();
			expect(
				resolveModel(registry, `${providerModelId}-1m`, "openai"),
			).toBeUndefined();
			expect(
				resolveModel(registry, `${providerModelId}-full`, "openai"),
			).toBeUndefined();
		}
	});

	test.each(["gpt-6-sol", "gpt-6-luna"])(
		"registers %s with published limits and fast mode",
		(id) => {
			const registry = createModelRegistry(OPENAI_MODELS);
			expect(resolveModel(registry, id, "openai")).toMatchObject({
				id,
				contextWindow: 1_050_000,
				maxInputTokens: 270_000,
				maxOutputTokens: 128_000,
			});
			expect(supportsFastMode(registry, id, "openai")).toBe(true);
		},
	);

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
