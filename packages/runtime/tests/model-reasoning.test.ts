import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MODELS } from "@codelia/core";
import {
	getAnthropicReasoningModelTableIds,
	resolveAnthropicMaxTokens,
	resolveAnthropicReasoning,
	resolveMoonshotReasoning,
	resolveResponsesReasoning,
	resolveXaiReasoning,
	resolveZaiReasoning,
} from "../src/model-reasoning";

describe("model reasoning mapping", () => {
	test.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"preserves GPT-6.1 Terra %s reasoning",
		(requested) => {
			for (const model of ["gpt-6.1-terra", "openai/gpt-6.1-terra"]) {
				expect(resolveResponsesReasoning({ model, requested })).toMatchObject({
					applied: requested,
					effort: requested,
					fallbackApplied: false,
					supportedLevels: ["low", "medium", "high", "xhigh", "max"],
				});
			}
		},
	);
	test.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"preserves GPT-6.1 Sol %s reasoning",
		(requested) => {
			for (const model of ["gpt-6.1-sol", "openai/gpt-6.1-sol"]) {
				expect(resolveResponsesReasoning({ model, requested })).toMatchObject({
					applied: requested,
					effort: requested,
					fallbackApplied: false,
					supportedLevels: ["low", "medium", "high", "xhigh", "max"],
				});
			}
		},
	);
	test.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"preserves Astra %s reasoning",
		(requested) => {
			for (const model of ["gpt-6-astra", "openai/gpt-6-astra"]) {
				expect(resolveResponsesReasoning({ model, requested })).toMatchObject({
					applied: requested,
					effort: requested,
					fallbackApplied: false,
				});
			}
		},
	);
	test("preserves max reasoning for GPT-6 Sol and Luna", () => {
		for (const modelId of ["gpt-6-sol", "gpt-6-luna"]) {
			for (const model of [modelId, `openai/${modelId}`]) {
				expect(
					resolveResponsesReasoning({ model, requested: "max" }),
				).toMatchObject({
					applied: "max",
					effort: "max",
					fallbackApplied: false,
				});
			}
		}
	});

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

	test.each(["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-codex"])(
		"falls back max to high for original GPT-5 model %s",
		(model) => {
			const mapped = resolveResponsesReasoning({
				model,
				requested: "max",
			});
			expect(mapped.requested).toBe("max");
			expect(mapped.applied).toBe("high");
			expect(mapped.effort).toBe("high");
			expect(mapped.fallbackApplied).toBe(true);
		},
	);

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

	test("maps every Moonshot request to Kimi K3 max reasoning", () => {
		expect(resolveMoonshotReasoning({ requested: "low" })).toMatchObject({
			requested: "low",
			applied: "max",
			effort: "max",
			fallbackApplied: true,
		});
		expect(resolveMoonshotReasoning({ requested: "max" })).toMatchObject({
			requested: "max",
			applied: "max",
			effort: "max",
			fallbackApplied: false,
		});
	});

	test("maps xAI reasoning to low, medium, or high", () => {
		expect(resolveXaiReasoning({ requested: "low" })).toMatchObject({
			requested: "low",
			applied: "low",
			effort: "low",
			fallbackApplied: false,
		});
		expect(resolveXaiReasoning({ requested: "medium" })).toMatchObject({
			requested: "medium",
			applied: "medium",
			effort: "medium",
			fallbackApplied: false,
		});
		expect(resolveXaiReasoning({ requested: "max" })).toMatchObject({
			requested: "max",
			applied: "high",
			effort: "high",
			fallbackApplied: true,
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

	test.each(["xhigh", "max"] as const)(
		"maps Claude Fable 5 %s to native adaptive effort",
		(requested) => {
			const mapped = resolveAnthropicReasoning({
				model: "claude-fable-5",
				requested,
			});
			expect(mapped.applied).toBe(requested);
			expect(mapped.thinking).toEqual({ type: "adaptive" });
			expect(mapped.outputConfig).toEqual({ effort: requested });
			expect(mapped.fallbackApplied).toBe(false);
			expect(mapped.usedFallbackModelProfile).toBe(false);
		},
	);

	test.each(["claude-opus-4-5", "claude-opus-4-5-20251201"])(
		"falls back max to manual-thinking xhigh for %s",
		(model) => {
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
		},
	);

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

	test.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"maps Claude Opus 5 %s to native adaptive effort",
		(requested) => {
			const mapped = resolveAnthropicReasoning({
				model: "claude-opus-5",
				requested,
			});
			expect(mapped.applied).toBe(requested);
			expect(mapped.thinking).toEqual({ type: "adaptive" });
			expect(mapped.outputConfig).toEqual({ effort: requested });
			expect(mapped.fallbackApplied).toBe(false);
			expect(mapped.usedFallbackModelProfile).toBe(false);
		},
	);

	test("maps new Claude models to all five native adaptive efforts", () => {
		for (const model of [
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
			"claude-fable-5-1",
			"claude-opus-5-5",
			"claude-sonnet-5",
		]) {
			for (const requested of [
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			] as const) {
				const mapped = resolveAnthropicReasoning({ model, requested });
				expect(mapped.applied).toBe(requested);
				expect(mapped.thinking).toEqual({ type: "adaptive" });
				expect(mapped.outputConfig).toEqual({ effort: requested });
				expect(mapped.fallbackApplied).toBe(false);
				expect(mapped.usedFallbackModelProfile).toBe(false);
			}
		}
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

describe("current provider reasoning contracts", () => {
	test.each([
		["low", "low"],
		["medium", "low"],
		["high", "high"],
		["xhigh", "high"],
		["max", "max"],
	] as const)("maps K3.1 and GLM-5.3 %s to %s", (requested, applied) => {
		for (const model of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
			expect(resolveMoonshotReasoning({ model, requested })).toEqual({
				requested,
				applied,
				effort: applied,
				fallbackApplied: requested !== applied,
				supportedLevels: ["low", "high", "max"],
			});
		}
		expect(resolveZaiReasoning({ model: "glm-5.3", requested })).toEqual({
			requested,
			applied,
			effort: applied,
			fallbackApplied: requested !== applied,
			supportedLevels: ["low", "high", "max"],
		});
	});
	test("retains Grok 4.7 xhigh and maps max to xhigh while keeping 4.5 at high", () => {
		for (const requested of ["xhigh", "max"] as const) {
			expect(
				resolveXaiReasoning({ model: "grok-4.7", requested }),
			).toMatchObject({
				applied: "xhigh",
				effort: "xhigh",
				fallbackApplied: requested !== "xhigh",
			});
			expect(
				resolveXaiReasoning({ model: "grok-4.5", requested }),
			).toMatchObject({
				applied: "high",
				effort: "high",
				fallbackApplied: true,
			});
		}
	});
});
