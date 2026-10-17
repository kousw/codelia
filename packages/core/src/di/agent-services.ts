import type { ToolOutputCacheStore } from "../services/tool-output-cache/store";
import type { ModelMetadataService } from "./model-metadata";

export type AgentServices = {
	resolveImage?: (
		ref: import("@codelia/shared-types").ImageArtifactRef,
		signal?: AbortSignal,
	) => Promise<import("../types/llm/content").ImagePart>;
	modelMetadata?: ModelMetadataService;
	toolOutputCacheStore?: ToolOutputCacheStore | null;
	monotonicNowMs?: () => number;
	llmRetryNowMs?: () => number;
	llmRetryRandom?: () => number;
	llmRetrySleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};
