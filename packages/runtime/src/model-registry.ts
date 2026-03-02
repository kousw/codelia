import type {
	BaseChatModel,
	ModelEntry,
	ModelRegistry,
} from "@codelia/core";
import {
	applyModelMetadata,
	DEFAULT_MODEL_REGISTRY,
	registerModels,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import { StoragePathServiceImpl } from "@codelia/storage";

type ModelRegistryMetadataService = {
	getAllModelEntries(): Promise<Record<string, Record<string, ModelEntry>>>;
	refreshAllModelEntries(): Promise<Record<string, Record<string, ModelEntry>>>;
};

const stripProviderPrefix = (provider: string, model: string): string => {
	const prefix = `${provider}/`;
	return model.startsWith(prefix) ? model.slice(prefix.length) : model;
};

const resolveProviderModelEntry = (
	providerEntries: Record<string, ModelEntry> | undefined,
	provider: BaseChatModel["provider"],
	model: string,
): ModelEntry | null => {
	if (!providerEntries) {
		return null;
	}
	const normalized = stripProviderPrefix(provider, model);
	const directCandidates = [
		model,
		normalized,
		`${provider}/${normalized}`,
	].filter((value, index, array) => array.indexOf(value) === index);
	for (const candidate of directCandidates) {
		const entry = providerEntries[candidate];
		if (entry) {
			return entry;
		}
	}
	const normalizedLower = normalized.toLowerCase();
	for (const [entryId, entry] of Object.entries(providerEntries)) {
		if (entryId.toLowerCase() === normalizedLower) {
			return entry;
		}
	}
	return null;
};

const toPositiveInteger = (value: unknown): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return Math.trunc(value);
};

const withOpenRouterDynamicModel = (
	registry: ModelRegistry,
	llm: BaseChatModel,
	entry: ModelEntry,
): ModelRegistry => {
	if (llm.provider !== "openrouter") {
		return registry;
	}
	const normalized = stripProviderPrefix(llm.provider, llm.model);
	if (!normalized) {
		return registry;
	}
	const contextWindow =
		toPositiveInteger(entry.limits?.contextWindow) ??
		toPositiveInteger(entry.limits?.inputTokens);
	const maxInputTokens =
		toPositiveInteger(entry.limits?.inputTokens) ?? contextWindow;
	const maxOutputTokens = toPositiveInteger(entry.limits?.outputTokens);
	if (!contextWindow && !maxInputTokens && !maxOutputTokens) {
		return registry;
	}
	const aliases = [llm.model, `${llm.provider}/${normalized}`]
		.filter((value) => value !== normalized)
		.filter((value, index, array) => array.indexOf(value) === index);
	const next: ModelRegistry = {
		modelsById: { ...registry.modelsById },
		aliasesByProvider: {
			openai: { ...registry.aliasesByProvider.openai },
			anthropic: { ...registry.aliasesByProvider.anthropic },
			openrouter: { ...registry.aliasesByProvider.openrouter },
			google: { ...registry.aliasesByProvider.google },
		},
	};
	registerModels(next, [
		{
			id: normalized,
			provider: llm.provider,
			...(aliases.length ? { aliases } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxInputTokens ? { maxInputTokens } : {}),
			...(maxOutputTokens ? { maxOutputTokens } : {}),
		},
	]);
	return next;
};

export const buildModelRegistry = async (
	llm: BaseChatModel,
	options: {
		strict?: boolean;
		metadataService?: ModelRegistryMetadataService;
	} = {},
): Promise<ModelRegistry> => {
	const strict = options.strict ?? true;
	const metadataService =
		options.metadataService ??
		new ModelMetadataServiceImpl({
			storagePathService: new StoragePathServiceImpl(),
		});
	let entries = await metadataService.getAllModelEntries();
	let providerEntries = entries[llm.provider];
	let resolvedEntry = resolveProviderModelEntry(
		providerEntries,
		llm.provider,
		llm.model,
	);
	if (!resolvedEntry) {
		entries = await metadataService.refreshAllModelEntries();
		providerEntries = entries[llm.provider];
		resolvedEntry = resolveProviderModelEntry(
			providerEntries,
			llm.provider,
			llm.model,
		);
	}
	if (!resolvedEntry) {
		if (strict) {
			throw new Error(
				`Model metadata not found for ${llm.provider}/${llm.model} after refresh`,
			);
		}
	}
	const baseRegistry = applyModelMetadata(DEFAULT_MODEL_REGISTRY, {
		models: entries,
	});
	return resolvedEntry
		? withOpenRouterDynamicModel(baseRegistry, llm, resolvedEntry)
		: baseRegistry;
};
