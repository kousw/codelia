import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "@codelia/core";
import { buildProviderModelList } from "../src/rpc/model";

describe("model.list static providers", () => {
	test("details follow merged runtime registry for static providers", async () => {
		const providerEntries: Record<string, ModelEntry> = {
			"gpt-5.4": {
				provider: "openai",
				modelId: "gpt-5.4",
				limits: {
					contextWindow: 300_000,
					inputTokens: 250_000,
					outputTokens: 16_000,
				},
				releaseDate: "2026-03-01",
			},
			"gpt-5.3-codex": {
				provider: "openai",
				modelId: "gpt-5.3-codex",
				limits: {
					contextWindow: 500_000,
					inputTokens: 450_000,
					outputTokens: 32_000,
				},
				releaseDate: "2026-02-01",
			},
		};

		const result = await buildProviderModelList({
			provider: "openai",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: providerEntries,
		});

		expect(result.details?.["gpt-5.4"]).toEqual({
			release_date: "2026-03-01",
			context_window: 1_050_000,
			max_input_tokens: 942_000,
			max_output_tokens: 128_000,
		});
		expect(result.details?.["gpt-5.3-codex"]).toEqual({
			release_date: "2026-02-01",
			context_window: 500_000,
			max_input_tokens: 450_000,
			max_output_tokens: 32_000,
		});
	});
});
