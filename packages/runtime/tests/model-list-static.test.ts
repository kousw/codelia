import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "@codelia/core";
import { buildProviderModelList } from "../src/rpc/model";

describe("model.list static providers", () => {
	test("details follow merged runtime registry for static providers", async () => {
		const providerEntries: Record<string, ModelEntry> = {
			"gpt-5.5": {
				provider: "openai",
				modelId: "gpt-5.5",
				limits: {
					contextWindow: 400_000,
					inputTokens: 350_000,
					outputTokens: 16_000,
				},
				releaseDate: "2026-04-23",
			},
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
			"gpt-5.3-codex-spark": {
				provider: "openai",
				modelId: "gpt-5.3-codex-spark",
				releaseDate: "2026-02-12",
			},
		};

		const result = await buildProviderModelList({
			provider: "openai",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: providerEntries,
		});

		expect(result.details?.["gpt-5.5"]).toEqual({
			release_date: "2026-04-23",
			context_window: 1_050_000,
			max_input_tokens: 270_000,
			max_output_tokens: 130_000,
		});
		expect(result.details?.["gpt-5.5-1M"]).toEqual({
			release_date: "2026-04-23",
			context_window: 1_050_000,
			max_input_tokens: 920_000,
			max_output_tokens: 130_000,
		});
		expect(result.details?.["gpt-5.4"]).toEqual({
			release_date: "2026-03-01",
			context_window: 1_050_000,
			max_input_tokens: 272_000,
			max_output_tokens: 128_000,
		});
		expect(result.details?.["gpt-5.4-1M"]).toEqual({
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
		expect(result.details?.["gpt-5.3-codex-spark"]).toEqual({
			release_date: "2026-02-12",
			context_window: 128_000,
		});
	});

	test("filters static provider models without usable limits when metadata is missing", async () => {
		const result = await buildProviderModelList({
			provider: "openai",
			includeDetails: false,
			log: () => {},
			providerEntriesOverride: {},
		});

		expect(result.models).toContain("gpt-5.5");
		expect(result.models).toContain("gpt-5.5-1M");
		expect(result.models).not.toContain("gpt-5.5-pro");
		expect(result.models).not.toContain("gpt-5.3-codex");
	});
});
