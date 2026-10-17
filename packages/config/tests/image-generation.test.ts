import { describe, expect, test } from "bun:test";
import {
	ConfigRegistry,
	OPENAI_IMAGE_MODELS,
	parseConfig,
	parseImageGenerationConfig,
} from "../src";

const custom = {
	mode: "custom",
	provider: "openai",
	model: OPENAI_IMAGE_MODELS[0],
} as const;
describe("image generation configuration", () => {
	test("default remains absent/off and project replaces the whole block", () => {
		const registry = new ConfigRegistry();
		expect(registry.resolve([]).image_generation).toBeUndefined();
		const global = parseConfig(
			{
				version: 1,
				image_generation: { ...custom, api_key_env: "CUSTOM_IMAGE_KEY" },
			},
			"global",
		);
		const project = parseConfig(
			{ version: 1, image_generation: { mode: "off" } },
			"project",
		);
		expect(registry.resolve([global, project]).image_generation).toEqual({
			mode: "off",
		});
		expect(
			registry.resolve([global, { image_generation: { mode: "builtin" } }])
				.image_generation,
		).toEqual({ mode: "builtin" });
	});
	test.each([
		{ mode: "off", model: "ignored" },
		{ mode: "builtin", api_key_env: "KEY" },
		{ mode: "custom", provider: "openai" },
		{ ...custom, api_key: "literal-secret" },
		{ ...custom, api_key_env: "not-an-env-name" },
		{ ...custom, model: "unknown-image-model" },
		{ ...custom, provider: "anthropic" },
		{
			...custom,
			provider_options: { openai: { base_url: "https://bad.test" } },
		},
		{
			...custom,
			provider_options: { openai: { model: OPENAI_IMAGE_MODELS[1] } },
		},
		{ ...custom, provider_options: { openai: { quality: "extreme" } } },
		{
			...custom,
			provider_options: {
				openrouter: { headers: { Authorization: "secret" } },
			},
		},
	] as unknown[])("rejects unsupported/control-plane settings %#", (value) => {
		expect(() => parseImageGenerationConfig(value)).toThrow(
			"Invalid image_generation",
		);
	});
	test("keeps inactive validated namespaces but never merges provider modes", () => {
		expect(
			parseImageGenerationConfig({
				...custom,
				provider_options: {
					openai: { quality: "high" },
					openrouter: { endpoint: "pinned" },
				},
			}),
		).toMatchObject({
			provider_options: {
				openai: { quality: "high" },
				openrouter: { endpoint: "pinned" },
			},
		});
	});
});
