import type {
	ModelCost,
	ModelEntry,
	ModelLimits,
	ModelMetadataIndex,
} from "@codelia/core";

export type { ModelCost, ModelEntry, ModelLimits, ModelMetadataIndex };

export type ModelMetadataSource = {
	getModelEntry(provider: string, modelId: string): Promise<ModelEntry | null>;
	getModelEntries(provider: string): Promise<ModelEntry[] | null>;
	getAllModelEntries(): Promise<Record<string, Record<string, ModelEntry>>>;
};
