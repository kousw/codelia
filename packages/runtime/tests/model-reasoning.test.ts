import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS } from "@codelia/core";
import {
	getAnthropicReasoningModelTableIds,
	resolveAnthropicMaxTokens,
	resolveAnthropicReasoning,
	resolveResponsesReasoning,
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

	test("maps Claude Opus 4.7 to adaptive thinking and output effort", () => {
		const mapped = resolveAnthropicReasoning({
			model: "claude-opus-4-7",
			requested: "xhigh",
		});
		expect(mapped.applied).toBe("xhigh");
		expect(mapped.budgetPreset).toBe("reasoning_xhigh");
		expect(mapped.thinking).toEqual({ type: "adaptive" });
		expect(mapped.outputConfig).toEqual({ effort: "max" });
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
