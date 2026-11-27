import type { ModelCost, ModelMetadataIndex } from "../di/model-metadata";
import type { ProviderName } from "../llm/base";
import type { ChatInvokeUsage } from "../types/llm/invoke";

export type ModelSpec = {
	id: string;
	provider: ProviderName;
	providerModelId?: string;
	aliases?: string[];
	contextWindow?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	cost?: ModelCost;
	supportsTools?: boolean;
	supportsVision?: boolean;
	supportsReasoning?: boolean;
	supportsFast?: boolean;
	supportsJsonSchema?: boolean;
};

const isNonNegativeFinite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Estimates per-call USD cost from normalized usage (where `input_tokens`
 * already includes cached and cache-creation tokens) and USD-per-1M-tokens
 * `ModelCost`. Returns `null` when required list prices are unavailable.
 */
export function estimateUsageCostUsd(
	usage: ChatInvokeUsage | null | undefined,
	cost: ModelCost | undefined,
): number | null {
	if (
		!usage ||
		!cost ||
		!isNonNegativeFinite(cost.input) ||
		!isNonNegativeFinite(cost.output)
	) {
		return null;
	}
	const cacheRead = Math.max(0, usage.input_cached_tokens ?? 0);
	const cacheWrite = Math.max(0, usage.input_cache_creation_tokens ?? 0);
	const uncachedInput = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
	const reasoningTokens = Math.max(0, usage.output_reasoning_tokens ?? 0);
	const nonReasoningOutput = Math.max(0, usage.output_tokens - reasoningTokens);
	const cacheReadRate = isNonNegativeFinite(cost.cacheRead)
		? cost.cacheRead
		: cost.input;
	const cacheWriteRate = isNonNegativeFinite(cost.cacheWrite)
		? cost.cacheWrite
		: cost.input;
	const reasoningRate = isNonNegativeFinite(cost.reasoning)
		? cost.reasoning
		: cost.output;
	const totalUsd =
		(uncachedInput * cost.input +
			cacheRead * cacheReadRate +
			cacheWrite * cacheWriteRate +
			nonReasoningOutput * cost.output +
			reasoningTokens * reasoningRate) /
		1_000_000;
	return Number.isFinite(totalUsd) ? totalUsd : null;
}

export type ModelRegistry = {
	modelsById: Record<string, ModelSpec>;
	aliasesByProvider: Record<string, Record<string, string>>;
};

export function createModelRegistry(specs: ModelSpec[]): ModelRegistry {
	const registry: ModelRegistry = {
		modelsById: {},
		aliasesByProvider: {
			openai: {},
			anthropic: {},
			openrouter: {},
			google: {},
			deepseek: {},
			moonshot: {},
			zai: {},
			xai: {},
		},
	};

	registerModels(registry, specs);
	return registry;
}

export function registerModels(
	registry: ModelRegistry,
	specs: ModelSpec[],
): void {
	for (const spec of specs) {
		registry.modelsById[spec.id] = spec;
		registry.aliasesByProvider[spec.provider] ??= {};
		const aliasBucket = registry.aliasesByProvider[spec.provider];
		for (const alias of spec.aliases ?? []) {
			aliasBucket[alias] = spec.id;
		}
	}
}

export function resolveModel(
	registry: ModelRegistry,
	idOrAlias: string,
	provider?: ProviderName,
): ModelSpec | undefined {
	const direct = registry.modelsById[idOrAlias];
	if (direct && (!provider || direct.provider === provider)) {
		return direct;
	}

	if (provider) {
		const aliasId = registry.aliasesByProvider[provider]?.[idOrAlias];
		return aliasId ? registry.modelsById[aliasId] : undefined;
	}

	let resolved: ModelSpec | undefined;
	for (const providerName of Object.keys(
		registry.aliasesByProvider,
	) as ProviderName[]) {
		const aliasId = registry.aliasesByProvider[providerName][idOrAlias];
		if (!aliasId) {
			continue;
		}
		if (resolved) {
			return undefined;
		}
		resolved = registry.modelsById[aliasId];
	}

	return resolved;
}

export function listModels(
	registry: ModelRegistry,
	provider?: ProviderName,
): ModelSpec[] {
	const all = Object.values(registry.modelsById);
	return provider ? all.filter((model) => model.provider === provider) : all;
}

const isPositiveFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value > 0;

export function isUsableModelSpec(spec: ModelSpec | undefined): boolean {
	return (
		isPositiveFiniteNumber(spec?.maxInputTokens) ||
		isPositiveFiniteNumber(spec?.contextWindow)
	);
}

export function resolveProviderModelId(
	registry: ModelRegistry,
	idOrAlias: string,
	provider?: ProviderName,
): string | undefined {
	const spec = resolveModel(registry, idOrAlias, provider);
	return spec ? (spec.providerModelId ?? spec.id) : undefined;
}

export function supportsFastMode(
	registry: ModelRegistry,
	idOrAlias: string,
	provider?: ProviderName,
): boolean {
	const spec = resolveModel(registry, idOrAlias, provider);
	return spec?.supportsFast === true;
}

function cloneAliases(
	aliasesByProvider: ModelRegistry["aliasesByProvider"],
): ModelRegistry["aliasesByProvider"] {
	return Object.fromEntries(
		Object.entries(aliasesByProvider).map(([provider, aliases]) => [
			provider,
			{ ...aliases },
		]),
	);
}

export function applyModelMetadata(
	registry: ModelRegistry,
	index: ModelMetadataIndex,
): ModelRegistry {
	const next: ModelRegistry = {
		modelsById: { ...registry.modelsById },
		aliasesByProvider: cloneAliases(registry.aliasesByProvider),
	};

	for (const [providerId, providerModels] of Object.entries(index.models)) {
		if (
			providerId !== "openai" &&
			providerId !== "anthropic" &&
			providerId !== "openrouter" &&
			providerId !== "google" &&
			providerId !== "deepseek" &&
			providerId !== "moonshot" &&
			providerId !== "zai" &&
			providerId !== "xai"
		) {
			continue;
		}
		const provider = providerId as ProviderName;
		for (const [modelId, entry] of Object.entries(providerModels)) {
			const fullId = `${provider}/${modelId}`;
			const spec =
				resolveModel(next, fullId, provider) ??
				resolveModel(next, modelId, provider);
			if (!spec) continue;

			next.modelsById[spec.id] = {
				...spec,
				contextWindow: spec.contextWindow ?? entry.limits?.contextWindow,
				maxInputTokens: spec.maxInputTokens ?? entry.limits?.inputTokens,
				maxOutputTokens: spec.maxOutputTokens ?? entry.limits?.outputTokens,
				cost: spec.cost ?? entry.cost,
				supportsFast: spec.supportsFast ?? entry.capabilities?.supportsFast,
				supportsVision:
					spec.supportsVision ?? entry.capabilities?.supportsVision,
				supportsTools: spec.supportsTools ?? entry.capabilities?.supportsTools,
			};
		}
	}

	return next;
}
