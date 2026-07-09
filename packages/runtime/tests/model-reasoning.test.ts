import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS } from "@codelia/core";
import {
	getAnthropicReasoningModelTableIds,
	resolveAnthropicMaxTokens,
	resolveAnthropicReasoning,
	resolveResponsesReasoning,
	resolveZaiReasoning,
} from "../src/model-reasoning";

describe("model reasoning mapping", () => {
	test("falls back xhigh to high for responses models without xhigh support", () => {
		const mapped = resolveResponsesReasoning({
			model: "gpt-5.1",
			requested: "xhigh",
		});
		expect(mapped.requested).toBe("xhigh");
		expect(mapped.applied).toBe("high");
		expect(mapped.effort).toBe("high");
		expect(mapped.fallbackApplied).toBe(true);
	});

	test("keeps xhigh for responses models with xhigh support", () => {
		const mapped = resolveResponsesReasoning({
			model: "gpt-5.2-codex",
			requested: "xhigh",
		});
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.fallbackApplied).toBe(false);
	});

	test("keeps max for GPT-5.6 responses models", () => {
		const mapped = resolveResponsesReasoning({
			model: "gpt-5.6-sol",
			requested: "max",
		});
		expect(mapped.applied).toBe("max");
		expect(mapped.effort).toBe("max");
		expect(mapped.fallbackApplied).toBe(false);
	});

	test("recognizes OpenRouter-prefixed GPT-5.6 for max effort", () => {
		const mapped = resolveResponsesReasoning({
			model: "openai/gpt-5.6",
			requested: "max",
		});
		expect(mapped.applied).toBe("max");
		expect(mapped.fallbackApplied).toBe(false);
	});

	test("falls back max to xhigh for responses models without max support", () => {
		const mapped = resolveResponsesReasoning({
			model: "gpt-5.5",
			requested: "max",
		});
		expect(mapped.requested).toBe("max");
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.effort).toBe("xhigh");
		expect(mapped.fallbackApplied).toBe(true);
	});

	test.each([
		"gpt-5",
		"gpt-5-mini",
		"gpt-5-nano",
		"gpt-5-codex",
	])("falls back max to high for original GPT-5 model %s", (model) => {
		const mapped = resolveResponsesReasoning({
			model,
			requested: "max",
		});
		expect(mapped.requested).toBe("max");
		expect(mapped.applied).toBe("high");
		expect(mapped.effort).toBe("high");
		expect(mapped.fallbackApplied).toBe(true);
	});

	test("maps zai reasoning to provider-supported effort values", () => {
		expect(resolveZaiReasoning({ requested: "low" })).toMatchObject({
			requested: "low",
			applied: "high",
			effort: "high",
			fallbackApplied: true,
		});
		expect(resolveZaiReasoning({ requested: "medium" })).toMatchObject({
			requested: "medium",
			applied: "high",
			effort: "high",
			fallbackApplied: true,
		});
		expect(resolveZaiReasoning({ requested: "high" })).toMatchObject({
			requested: "high",
			applied: "high",
			effort: "high",
			fallbackApplied: false,
		});
		expect(resolveZaiReasoning({ requested: "xhigh" })).toMatchObject({
			requested: "xhigh",
			applied: "xhigh",
			effort: "max",
			fallbackApplied: false,
		});
		expect(resolveZaiReasoning({ requested: "max" })).toMatchObject({
			requested: "max",
			applied: "max",
			effort: "max",
			fallbackApplied: false,
		});
	});

	test("maps anthropic known model reasoning to thinking budget preset", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-sonnet-4-5",
			requested: "xhigh",
		});
		expect(mapped.requested).toBe("xhigh");
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.budgetPreset).toBe("reasoning_xhigh");
		expect(mapped.thinking).toEqual({
			type: "enabled",
			budget_tokens: 49_152,
		});
		expect(mapped.usedFallbackModelProfile).toBe(false);
	});

	test.each([
		"claude-opus-4-5",
		"claude-opus-4-5-20251201",
	])("falls back max to manual-thinking xhigh for %s", (model) => {
		const mapped = resolveAnthropicReasoning({
			model,
			requested: "max",
		});
		expect(mapped.requested).toBe("max");
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.budgetPreset).toBe("reasoning_xhigh");
		expect(mapped.thinking).toEqual({
			type: "enabled",
			budget_tokens: 49_152,
		});
		expect(mapped.outputConfig).toBeUndefined();
		expect(mapped.fallbackApplied).toBe(true);
		expect(mapped.usedFallbackModelProfile).toBe(false);
	});

	test("maps Claude Opus 4.7 to adaptive thinking and output effort", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-opus-4-7",
			requested: "xhigh",
		});
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.budgetPreset).toBe("reasoning_xhigh");
		expect(mapped.thinking).toEqual({ type: "adaptive" });
		expect(mapped.outputConfig).toEqual({ effort: "xhigh" });
		expect(mapped.usedFallbackModelProfile).toBe(false);
	});

	test("maps Claude Opus 4.7 max distinctly from xhigh", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-opus-4-7",
			requested: "max",
		});
		expect(mapped.applied).toBe("max");
		expect(mapped.budgetPreset).toBe("reasoning_xhigh");
		expect(mapped.thinking).toEqual({ type: "adaptive" });
		expect(mapped.outputConfig).toEqual({ effort: "max" });
		expect(mapped.fallbackApplied).toBe(false);
	});

	test("supports max but not xhigh for Claude Opus 4.6", () => {
		const max = resolveAnthropicReasoning({
			model: "claude-opus-4-6",
			requested: "max",
		});
		expect(max.applied).toBe("max");
		expect(max.thinking).toEqual({ type: "adaptive" });
		expect(max.outputConfig).toEqual({ effort: "max" });

		const xhigh = resolveAnthropicReasoning({
			model: "claude-opus-4-6",
			requested: "xhigh",
		});
		expect(xhigh.applied).toBe("high");
		expect(xhigh.outputConfig).toEqual({ effort: "high" });
		expect(xhigh.fallbackApplied).toBe(true);
	});

	test("maps Claude Opus 4.8 to adaptive thinking and output effort", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-opus-4-8",
			requested: "high",
		});
		expect(mapped.applied).toBe("high");
		expect(mapped.budgetPreset).toBe("reasoning_high");
		expect(mapped.thinking).toEqual({ type: "adaptive" });
		expect(mapped.outputConfig).toEqual({ effort: "high" });
		expect(mapped.usedFallbackModelProfile).toBe(false);
	});

	test("uses conservative fallback profile for unknown anthropic model", () => {
		const missing: string[] = [];
		const mapped = resolveAnthropicReasoning({
			model: "claude-unknown-next",
			requested: "xhigh",
			onMissingExplicitModel: (model) => {
				missing.push(model);
			},
		});
		expect(mapped.requested).toBe("xhigh");
		expect(mapped.applied).toBe("high");
		expect(mapped.fallbackApplied).toBe(true);
		expect(mapped.budgetPreset).toBe("reasoning_high");
		expect(mapped.usedFallbackModelProfile).toBe(true);
		expect(missing).toEqual(["claude-unknown-next"]);
	});

	test("falls back max to high for unknown anthropic models", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-unknown-next",
			requested: "max",
		});
		expect(mapped.requested).toBe("max");
		expect(mapped.applied).toBe("high");
		expect(mapped.fallbackApplied).toBe(true);
	});

	test("sets anthropic max tokens above thinking budget", () => {
		expect(
			resolveAnthropicMaxTokens({
				thinkingBudgetTokens: 8_192,
			}),
		).toBe(12_288);
	});

	test("prefers model max tokens when available", () => {
		expect(
			resolveAnthropicMaxTokens({
				thinkingBudgetTokens: 8_192,
				modelLimitMaxTokens: 64_000,
			}),
		).toBe(64_000);
	});

	test("falls back to budget+headroom when model max tokens is not above budget", () => {
		expect(
			resolveAnthropicMaxTokens({
				thinkingBudgetTokens: 8_192,
				modelLimitMaxTokens: 8_192,
			}),
		).toBe(12_288);
	});

	test("anthropic reasoning table covers all configured anthropic model ids", () => {
		const modelIds = ANTHROPIC_MODELS.map((model) => model.id).sort();
		expect(getAnthropicReasoningModelTableIds()).toEqual(modelIds);
	});
});
