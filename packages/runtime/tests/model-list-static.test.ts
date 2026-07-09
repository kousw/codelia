import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "@codelia/core";
import { buildProviderModelList } from "../src/rpc/model";

describe("model.list static providers", () => {
	test("lists Claude Fable 5 from static metadata", async () => {
		const result = await buildProviderModelList({
			provider: "anthropic",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: {},
		});

		expect(result.models).toContain("claude-fable-5");
		expect(result.details?.["claude-fable-5"]).toEqual({
			context_window: 1_000_000,
			max_input_tokens: 1_000_000,
			max_output_tokens: 128_000,
		});
	});

	test("details follow merged runtime registry for static providers", async () => {
		const providerEntries: Record<string, ModelEntry> = {
			"gpt-5.6": {
				provider: "openai",
				modelId: "gpt-5.6",
				limits: {
					contextWindow: 1_050_000,
					inputTokens: 922_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-07-09",
			},
			"gpt-5.6-sol": {
				provider: "openai",
				modelId: "gpt-5.6-sol",
				limits: {
					contextWindow: 1_050_000,
					inputTokens: 922_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-07-09",
			},
			"gpt-5.6-terra": {
				provider: "openai",
				modelId: "gpt-5.6-terra",
				limits: {
					contextWindow: 1_050_000,
					inputTokens: 922_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-07-09",
			},
			"gpt-5.6-luna": {
				provider: "openai",
				modelId: "gpt-5.6-luna",
				limits: {
					contextWindow: 1_050_000,
					inputTokens: 922_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-07-09",
			},
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
			"gpt-5.4-pro": {
				provider: "openai",
				modelId: "gpt-5.4-pro",
				limits: {
					contextWindow: 1_050_000,
					inputTokens: 922_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-03-05",
			},
			"gpt-5.4-mini": {
				provider: "openai",
				modelId: "gpt-5.4-mini",
				limits: {
					contextWindow: 400_000,
					inputTokens: 272_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-03-17",
			},
			"gpt-5.4-nano": {
				provider: "openai",
				modelId: "gpt-5.4-nano",
				limits: {
					contextWindow: 400_000,
					inputTokens: 272_000,
					outputTokens: 128_000,
				},
				releaseDate: "2026-03-17",
			},
		};

		const result = await buildProviderModelList({
			provider: "openai",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: providerEntries,
		});

		for (const model of [
			"gpt-5.6",
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
		]) {
			expect(result.details?.[model]).toEqual({
				release_date: "2026-07-09",
				context_window: 1_050_000,
				max_input_tokens: 922_000,
				max_output_tokens: 128_000,
			});
		}
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
		expect(result.details?.["gpt-5.4-pro"]).toEqual({
			release_date: "2026-03-05",
			context_window: 1_050_000,
			max_input_tokens: 922_000,
			max_output_tokens: 128_000,
		});
		expect(result.details?.["gpt-5.4-mini"]).toEqual({
			release_date: "2026-03-17",
			context_window: 400_000,
			max_input_tokens: 272_000,
			max_output_tokens: 128_000,
		});
		expect(result.details?.["gpt-5.4-nano"]).toEqual({
			release_date: "2026-03-17",
			context_window: 400_000,
			max_input_tokens: 272_000,
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

		expect(result.models).toContain("gpt-5.6");
		expect(result.models).toContain("gpt-5.6-sol");
		expect(result.models).toContain("gpt-5.6-terra");
		expect(result.models).toContain("gpt-5.6-luna");
		expect(result.models).toContain("gpt-5.5");
		expect(result.models).toContain("gpt-5.5-1M");
		expect(result.models).toContain("gpt-5.4-pro");
		expect(result.models).toContain("gpt-5.4-mini");
		expect(result.models).toContain("gpt-5.4-nano");
		expect(result.models).not.toContain("gpt-5.5-pro");
		expect(result.models).not.toContain("gpt-5.3-codex");
	});

	test("omits details for non-Z.ai static providers when metadata is unavailable", async () => {
		const result = await buildProviderModelList({
			provider: "openai",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: null,
		});

		expect(result.models).toContain("gpt-5.5");
		expect(result.details).toBeUndefined();
	});

	test("lists static zai model details without dynamic metadata", async () => {
		const result = await buildProviderModelList({
			provider: "zai",
			includeDetails: true,
			log: () => {},
			providerEntriesOverride: {},
		});

		expect(result.models).toEqual([
			"glm-5.2",
			"glm-5.1",
			"glm-5",
			"glm-5-turbo",
			"glm-4.7",
		]);
		expect(result.details?.["glm-5.2"]).toEqual({
			context_window: 1_000_000,
			max_input_tokens: 1_000_000,
			max_output_tokens: 131_072,
		});
		expect(result.details?.["glm-5.1"]).toEqual({
			context_window: 200_000,
			max_input_tokens: 200_000,
			max_output_tokens: 131_072,
		});
	});
});
