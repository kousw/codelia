import type { ModelMetadataIndex } from "../di/model-metadata";
import type { ProviderName } from "../llm/base";

export type ModelSpec = {
	id: string;
	provider: ProviderName;
	aliases?: string[];
	contextWindow?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	supportsTools?: boolean;
	supportsVision?: boolean;
	supportsReasoning?: boolean;
	supportsJsonSchema?: boolean;
};

export type ModelRegistry = {
	modelsById: Record<string, ModelSpec>;
	aliasesByProvider: Record<ProviderName, Record<string, string>>;
};

export function createModelRegistry(specs: ModelSpec[]): ModelRegistry {
	const registry: ModelRegistry = {
		modelsById: {},
		aliasesByProvider: {
			openai: {},
			anthropic: {},
			google: {},
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
	if (direct) {
		return direct;
	}

	if (provider) {
		const aliasId = registry.aliasesByProvider[provider][idOrAlias];
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

function cloneAliases(
	aliasesByProvider: ModelRegistry["aliasesByProvider"],
): ModelRegistry["aliasesByProvider"] {
	return {
		openai: { ...aliasesByProvider.openai },
		anthropic: { ...aliasesByProvider.anthropic },
		google: { ...aliasesByProvider.google },
	};
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
			providerId !== "google"
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

			const limits = entry.limits;
			if (!limits) continue;

			next.modelsById[spec.id] = {
				...spec,
				contextWindow: spec.contextWindow ?? limits.contextWindow,
				maxInputTokens: spec.maxInputTokens ?? limits.inputTokens,
				maxOutputTokens: spec.maxOutputTokens ?? limits.outputTokens,
			};
		}
	}

	return next;
}
