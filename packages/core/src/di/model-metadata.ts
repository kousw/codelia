export type ModelCost = {
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
	inputAudio?: number;
	outputAudio?: number;
};

export type ModelLimits = {
	contextWindow?: number;
	inputTokens?: number;
	outputTokens?: number;
};

export type ModelEntry = {
	provider: string;
	modelId: string;
	cost?: ModelCost;
	limits?: ModelLimits;
};

export type ModelMetadataIndex = {
	models: Record<string, Record<string, ModelEntry>>;
};

export interface ModelMetadataService {
	getModelEntry(provider: string, modelId: string): Promise<ModelEntry | null>;
	getModelEntries(provider: string): Promise<ModelEntry[] | null>;
	getAllModelEntries(): Promise<Record<string, Record<string, ModelEntry>>>;
}
