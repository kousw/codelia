import { describe, expect, test } from "bun:test";
import type { SupportedProvider } from "../src/auth/resolver";
import type { ProviderAuth } from "../src/auth/store";
import { createRuntimeModel } from "../src/model-factory";

const apiKeyAuth: ProviderAuth = {
	method: "api_key",
	api_key: "test-api-key",
};

const cases: Array<{
	provider: SupportedProvider;
	model: string;
}> = [
	{ provider: "openai", model: "gpt-5.6" },
	{ provider: "openrouter", model: "openai/gpt-5.6" },
	{ provider: "anthropic", model: "claude-sonnet-4-6" },
	{ provider: "zai", model: "glm-5.2" },
	{ provider: "moonshot", model: "kimi-k3" },
	{ provider: "xai", model: "grok-4.5" },
];

describe("runtime model factory", () => {
	for (const { provider, model } of cases) {
		test(`constructs the ${provider} adapter from explicit inputs`, async () => {
			const result = await createRuntimeModel({
				provider,
				config: {
					name: model,
					reasoning: "medium",
					fast: true,
				},
				auth: apiKeyAuth,
				useMetadata: false,
				log: () => {},
			});

			expect(result.llm.provider).toBe(provider);
			expect(result.llm.model).toBe(model);
			expect(result.resolvedModelName).toBe(model);
		});
	}

	test("rejects OAuth credentials for API-key-only providers", async () => {
		await expect(
			createRuntimeModel({
				provider: "anthropic",
				config: { name: "claude-sonnet-4-6" },
				auth: {
					method: "oauth",
					oauth: {
						access_token: "test-access-token",
						refresh_token: "test-refresh-token",
						expires_at: Date.now() + 60_000,
					},
				},
				useMetadata: false,
				log: () => {},
			}),
		).rejects.toThrow("Anthropic requires an API key");
	});
});
