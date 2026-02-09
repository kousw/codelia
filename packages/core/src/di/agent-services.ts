import type { ToolOutputCacheStore } from "../services/tool-output-cache/store";
import type { ModelMetadataService } from "./model-metadata";

export type AgentServices = {
	modelMetadata?: ModelMetadataService;
	toolOutputCacheStore?: ToolOutputCacheStore | null;
};
