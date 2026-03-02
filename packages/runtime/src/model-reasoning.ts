export type CanonicalReasoningLevel = "low" | "medium" | "high" | "xhigh";

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
	thinking: {
		type: "enabled";
		budget_tokens: number;
	};
	budgetPreset: AnthropicBudgetPresetId;
	usedFallbackModelProfile: boolean;
};

type AnthropicReasoningModelProfile = {
	supportedLevels: readonly CanonicalReasoningLevel[];
	budgetPresetByLevel: Partial<
		Record<CanonicalReasoningLevel, AnthropicBudgetPresetId>
	>;
};

export type AnthropicBudgetPresetId =
	| "reasoning_low"
	| "reasoning_medium"
	| "reasoning_high"
	| "reasoning_xhigh";

const REASONING_LEVEL_ORDER: readonly CanonicalReasoningLevel[] = [
	"low",
	"medium",
	"high",
	"xhigh",
];
const DEFAULT_REASONING_LEVEL: CanonicalReasoningLevel = "medium";

const RESPONSES_XHIGH_UNSUPPORTED_MODELS = new Set<string>([
	"gpt-5.1",
	"gpt-5.1-2025-11-13",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
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

const ANTHROPIC_REASONING_MODEL_TABLE: Readonly<
	Record<string, AnthropicReasoningModelProfile>
> = {
	"claude-opus-4-6": {
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
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
		supportedLevels: ["low", "medium", "high", "xhigh"],
		budgetPresetByLevel: {
			low: "reasoning_low",
			medium: "reasoning_medium",
			high: "reasoning_high",
			xhigh: "reasoning_xhigh",
		},
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

const supportsResponsesXhigh = (model: string): boolean =>
	!RESPONSES_XHIGH_UNSUPPORTED_MODELS.has(model);

export const resolveResponsesReasoning = ({
	model,
	requested,
}: {
	model: string;
	requested?: CanonicalReasoningLevel;
}): ResponsesReasoningResolution => {
	const supportedLevels = supportsResponsesXhigh(model)
		? REASONING_LEVEL_ORDER
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
	return {
		...resolution,
		thinking: {
			type: "enabled",
			budget_tokens: budgetTokens,
		},
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
