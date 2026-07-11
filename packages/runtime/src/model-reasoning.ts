import {
	MODEL_REASONING_LEVELS,
	type ModelReasoningLevel,
} from "@codelia/shared-types";

export type CanonicalReasoningLevel = ModelReasoningLevel;
export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningResolution = {
	requested: CanonicalReasoningLevel;
	applied: CanonicalReasoningLevel;
	fallbackApplied: boolean;
	supportedLevels: readonly CanonicalReasoningLevel[];
};

export type ResponsesReasoningResolution = ReasoningResolution & {
	effort: CanonicalReasoningLevel;
};

export type AnthropicReasoningResolution = ReasoningResolution & {
	thinking:
		| {
				type: "enabled";
				budget_tokens: number;
		  }
		| {
				type: "adaptive";
		  };
	outputConfig?: {
		effort: AnthropicOutputEffort;
	};
	budgetPreset: AnthropicBudgetPresetId;
	usedFallbackModelProfile: boolean;
};

export type ZaiReasoningResolution = {
	requested: CanonicalReasoningLevel;
	applied: "high" | "xhigh" | "max";
	effort: "high" | "max";
	fallbackApplied: boolean;
	supportedLevels: readonly CanonicalReasoningLevel[];
};

type AnthropicReasoningModelProfile = {
	supportedLevels: readonly CanonicalReasoningLevel[];
	budgetPresetByLevel: Partial<
		Record<CanonicalReasoningLevel, AnthropicBudgetPresetId>
	>;
	outputEffortByLevel?: Partial<
		Record<CanonicalReasoningLevel, AnthropicOutputEffort>
	>;
};

export type AnthropicBudgetPresetId =
	| "reasoning_low"
	| "reasoning_medium"
	| "reasoning_high"
	| "reasoning_xhigh";

const REASONING_LEVEL_ORDER = MODEL_REASONING_LEVELS;
const DEFAULT_REASONING_LEVEL: CanonicalReasoningLevel = "medium";

const RESPONSES_XHIGH_UNSUPPORTED_MODELS = new Set<string>([
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-mini-2025-08-07",
	"gpt-5-nano",
	"gpt-5-nano-2025-08-07",
	"gpt-5-codex",
	"gpt-5-codex-mini",
	"gpt-5.1",
	"gpt-5.1-2025-11-13",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
]);
const RESPONSES_MAX_SUPPORTED_MODELS = new Set<string>([
	"gpt-5.6",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

const ANTHROPIC_FALLBACK_PROFILE: AnthropicReasoningModelProfile = {
	supportedLevels: ["low", "medium", "high"],
	budgetPresetByLevel: {
		low: "reasoning_low",
		medium: "reasoning_medium",
		high: "reasoning_high",
	},
};

const ANTHROPIC_BUDGET_PRESET_TOKENS: Record<AnthropicBudgetPresetId, number> =
	{
		reasoning_low: 2_048,
		reasoning_medium: 8_192,
		reasoning_high: 24_576,
		reasoning_xhigh: 49_152,
	};
const ANTHROPIC_MAX_TOKENS_FALLBACK_HEADROOM = 4_096;

const ANTHROPIC_OUTPUT_EFFORT_ALL = {
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const satisfies Partial<
	Record<CanonicalReasoningLevel, AnthropicOutputEffort>
>;

const ANTHROPIC_OUTPUT_EFFORT_WITHOUT_XHIGH = {
	low: "low",
	medium: "medium",
	high: "high",
	max: "max",
} as const satisfies Partial<
	Record<CanonicalReasoningLevel, AnthropicOutputEffort>
>;

const ANTHROPIC_REASONING_MODEL_TABLE: Readonly<
	Record<string, AnthropicReasoningModelProfile>
> = {
	"claude-fable-5": {
		supportedLevels: ["low", "medium", "high", "xhigh", "max"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
			max: "reasoning_xhigh",
		},
		outputEffortByLevel: ANTHROPIC_OUTPUT_EFFORT_ALL,
	},
	"claude-opus-4-8": {
		supportedLevels: ["low", "medium", "high", "xhigh", "max"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
			max: "reasoning_xhigh",
		},
		outputEffortByLevel: ANTHROPIC_OUTPUT_EFFORT_ALL,
	},
	"claude-opus-4-7": {
		supportedLevels: ["low", "medium", "high", "xhigh", "max"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
			max: "reasoning_xhigh",
		},
		outputEffortByLevel: ANTHROPIC_OUTPUT_EFFORT_ALL,
	},
	"claude-opus-4-6": {
		supportedLevels: ["low", "medium", "high", "max"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			max: "reasoning_xhigh",
		},
		outputEffortByLevel: ANTHROPIC_OUTPUT_EFFORT_WITHOUT_XHIGH,
	},
	"claude-opus-4-5": {
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
	},
	"claude-opus-4-5-20251201": {
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
	},
	"claude-sonnet-4-6": {
		supportedLevels: ["low", "medium", "high", "max"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			max: "reasoning_xhigh",
		},
		outputEffortByLevel: ANTHROPIC_OUTPUT_EFFORT_WITHOUT_XHIGH,
	},
	"claude-sonnet-4-5": {
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
	},
	"claude-sonnet-4-5-20250929": {
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
	},
	"claude-haiku-4-5": {
		supportedLevels: ["low", "medium", "high"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
		},
	},
	"claude-haiku-4-5-20250929": {
		supportedLevels: ["low", "medium", "high"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
		},
	},
};

const ANTHROPIC_ADAPTIVE_THINKING_MODELS = new Set<string>([
	"claude-fable-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
]);

const normalizeRequestedReasoning = (
	value: CanonicalReasoningLevel | undefined,
): CanonicalReasoningLevel => value ?? DEFAULT_REASONING_LEVEL;

const resolveNearestSupportedLevel = (
	requested: CanonicalReasoningLevel,
	supportedLevels: readonly CanonicalReasoningLevel[],
): CanonicalReasoningLevel => {
	const supported = new Set(supportedLevels);
	const requestedIndex = REASONING_LEVEL_ORDER.indexOf(requested);
	for (let idx = requestedIndex; idx >= 0; idx -= 1) {
		const candidate = REASONING_LEVEL_ORDER[idx];
		if (supported.has(candidate)) {
			return candidate;
		}
	}
	for (const candidate of REASONING_LEVEL_ORDER) {
		if (supported.has(candidate)) {
			return candidate;
		}
	}
	return requested;
};

const resolveReasoningAgainstSupportedLevels = ({
	requested,
	supportedLevels,
}: {
	requested: CanonicalReasoningLevel | undefined;
	supportedLevels: readonly CanonicalReasoningLevel[];
}): ReasoningResolution => {
	const normalizedRequested = normalizeRequestedReasoning(requested);
	const applied = resolveNearestSupportedLevel(
		normalizedRequested,
		supportedLevels,
	);
	return {
		requested: normalizedRequested,
		applied,
		fallbackApplied: applied !== normalizedRequested,
		supportedLevels,
	};
};

const normalizeResponsesModelId = (model: string): string =>
	model.startsWith("openai/") ? model.slice("openai/".length) : model;

const supportsResponsesXhigh = (model: string): boolean =>
	!RESPONSES_XHIGH_UNSUPPORTED_MODELS.has(normalizeResponsesModelId(model));

const supportsResponsesMax = (model: string): boolean =>
	RESPONSES_MAX_SUPPORTED_MODELS.has(normalizeResponsesModelId(model));

export const resolveResponsesReasoning = ({
	model,
	requested,
}: {
	model: string;
	requested?: CanonicalReasoningLevel;
}): ResponsesReasoningResolution => {
	const supportedLevels = supportsResponsesMax(model)
		? REASONING_LEVEL_ORDER
		: supportsResponsesXhigh(model)
			? REASONING_LEVEL_ORDER.slice(0, 4)
			: REASONING_LEVEL_ORDER.slice(0, 3);
	const resolution = resolveReasoningAgainstSupportedLevels({
		requested,
		supportedLevels,
	});
	return {
		...resolution,
		effort: resolution.applied,
	};
};

const resolveAnthropicModelProfile = (
	model: string,
): {
	profile: AnthropicReasoningModelProfile;
	usedFallbackModelProfile: boolean;
} => {
	const profile = ANTHROPIC_REASONING_MODEL_TABLE[model];
	if (profile) {
		return { profile, usedFallbackModelProfile: false };
	}
	return {
		profile: ANTHROPIC_FALLBACK_PROFILE,
		usedFallbackModelProfile: true,
	};
};

export const resolveAnthropicReasoning = ({
	model,
	requested,
	onMissingExplicitModel,
}: {
	model: string;
	requested?: CanonicalReasoningLevel;
	onMissingExplicitModel?: (model: string) => void;
}): AnthropicReasoningResolution => {
	const { profile, usedFallbackModelProfile } =
		resolveAnthropicModelProfile(model);
	if (usedFallbackModelProfile) {
		onMissingExplicitModel?.(model);
	}
	const resolution = resolveReasoningAgainstSupportedLevels({
		requested,
		supportedLevels: profile.supportedLevels,
	});
	const preset = profile.budgetPresetByLevel[resolution.applied];
	if (!preset) {
		throw new Error(
			`Missing Anthropic reasoning budget preset for model '${model}' level '${resolution.applied}'`,
		);
	}
	const budgetTokens = ANTHROPIC_BUDGET_PRESET_TOKENS[preset];
	const outputEffort = profile.outputEffortByLevel?.[resolution.applied];
	return {
		...resolution,
		...(ANTHROPIC_ADAPTIVE_THINKING_MODELS.has(model)
			? {
					thinking: { type: "adaptive" as const },
				}
			: {
					thinking: {
						type: "enabled" as const,
						budget_tokens: budgetTokens,
					},
				}),
		...(outputEffort ? { outputConfig: { effort: outputEffort } } : {}),
		budgetPreset: preset,
		usedFallbackModelProfile,
	};
};

export const resolveAnthropicMaxTokens = ({
	thinkingBudgetTokens,
	modelLimitMaxTokens,
}: {
	thinkingBudgetTokens: number;
	modelLimitMaxTokens?: number | null;
}): number => {
	const normalizedBudget = Number.isFinite(thinkingBudgetTokens)
		? Math.max(0, Math.trunc(thinkingBudgetTokens))
		: 0;
	const normalizedModelLimit =
		typeof modelLimitMaxTokens === "number" &&
		Number.isFinite(modelLimitMaxTokens) &&
		modelLimitMaxTokens > 0
			? Math.trunc(modelLimitMaxTokens)
			: null;
	if (
		normalizedModelLimit !== null &&
		normalizedModelLimit > normalizedBudget
	) {
		return normalizedModelLimit;
	}
	return normalizedBudget + ANTHROPIC_MAX_TOKENS_FALLBACK_HEADROOM;
};

export const getAnthropicReasoningModelTableIds = (): string[] =>
	Object.keys(ANTHROPIC_REASONING_MODEL_TABLE).sort();

export const resolveZaiReasoning = ({
	requested,
}: {
	requested?: CanonicalReasoningLevel;
}): ZaiReasoningResolution => {
	const normalizedRequested = normalizeRequestedReasoning(requested);
	if (normalizedRequested === "xhigh" || normalizedRequested === "max") {
		return {
			requested: normalizedRequested,
			applied: normalizedRequested,
			effort: "max",
			fallbackApplied: false,
			supportedLevels: REASONING_LEVEL_ORDER,
		};
	}
	return {
		requested: normalizedRequested,
		applied: "high",
		effort: "high",
		fallbackApplied:
			normalizedRequested === "low" || normalizedRequested === "medium",
		supportedLevels: REASONING_LEVEL_ORDER,
	};
};
