import { describe, expect, test } from "bun:test";
import { TokenUsageService } from "../src/services/usage/service";
import type { ChatInvokeUsage } from "../src/types/llm/invoke";

describe("TokenUsageService", () => {
	test("aggregates usage by model", () => {
		const service = new TokenUsageService({
			enabled: true,
			thresholdRatio: 0.5,
		});

		const usage1: ChatInvokeUsage = {
			model: "model-a",
			input_tokens: 10,
			input_cached_tokens: 2,
			input_cache_creation_tokens: 1,
			output_tokens: 5,
			total_tokens: 15,
		};

		const usage2: ChatInvokeUsage = {
			model: "model-a",
			input_tokens: 3,
			output_tokens: 2,
			total_tokens: 5,
		};

		service.updateUsageSummary(usage1);
		service.updateUsageSummary(usage2);

		const summary = service.getUsageSummary();
		expect(summary.total_calls).toBe(2);
		expect(summary.total_input_tokens).toBe(13);
		expect(summary.total_output_tokens).toBe(7);
		expect(summary.total_tokens).toBe(20);
		expect(summary.total_cached_input_tokens).toBe(2);
		expect(summary.total_cache_creation_tokens).toBe(1);
		expect(summary.by_model["model-a"]?.calls).toBe(2);
		expect(summary.by_model["model-a"]?.input_tokens).toBe(13);
		expect(summary.by_model["model-a"]?.output_tokens).toBe(7);
		expect(summary.by_model["model-a"]?.cached_input_tokens).toBe(2);
		expect(summary.by_model["model-a"]?.cache_creation_tokens).toBe(1);
		expect(summary.by_model["model-a"]?.total_tokens).toBe(20);
	});

	test("ignores updates without usage", () => {
		const service = new TokenUsageService({
			enabled: true,
			thresholdRatio: 0.5,
		});

		service.updateUsageSummary(undefined);

		const summary = service.getUsageSummary();
		expect(summary.total_calls).toBe(0);
		expect(summary.total_input_tokens).toBe(0);
		expect(summary.total_output_tokens).toBe(0);
		expect(summary.total_tokens).toBe(0);
		expect(summary.total_cached_input_tokens).toBe(0);
		expect(summary.total_cache_creation_tokens).toBe(0);
		expect(Object.keys(summary.by_model)).toHaveLength(0);
		expect(service.getLastUsage()).toBeNull();
	});

	test("tracks usage separately per model", () => {
		const service = new TokenUsageService({
			enabled: true,
			thresholdRatio: 0.5,
		});

		service.updateUsageSummary({
			model: "model-a",
			input_tokens: 4,
			output_tokens: 1,
			total_tokens: 5,
		});

		service.updateUsageSummary({
			model: "model-b",
			input_tokens: 7,
			input_cached_tokens: 3,
			input_cache_creation_tokens: 2,
			output_tokens: 3,
			total_tokens: 10,
		});

		const summary = service.getUsageSummary();
		expect(summary.total_calls).toBe(2);
		expect(summary.total_input_tokens).toBe(11);
		expect(summary.total_output_tokens).toBe(4);
		expect(summary.total_tokens).toBe(15);
		expect(summary.total_cached_input_tokens).toBe(3);
		expect(summary.total_cache_creation_tokens).toBe(2);
		expect(summary.by_model["model-a"]?.calls).toBe(1);
		expect(summary.by_model["model-a"]?.input_tokens).toBe(4);
		expect(summary.by_model["model-a"]?.output_tokens).toBe(1);
		expect(summary.by_model["model-a"]?.cached_input_tokens).toBe(0);
		expect(summary.by_model["model-a"]?.cache_creation_tokens).toBe(0);
		expect(summary.by_model["model-a"]?.total_tokens).toBe(5);
		expect(summary.by_model["model-b"]?.calls).toBe(1);
		expect(summary.by_model["model-b"]?.input_tokens).toBe(7);
		expect(summary.by_model["model-b"]?.output_tokens).toBe(3);
		expect(summary.by_model["model-b"]?.cached_input_tokens).toBe(3);
		expect(summary.by_model["model-b"]?.cache_creation_tokens).toBe(2);
		expect(summary.by_model["model-b"]?.total_tokens).toBe(10);
	});
});
