import type { ToolOutputCacheStore } from "../services/tool-output-cache/store";
import type { ModelMetadataService } from "./model-metadata";

type ResolveImage = (
	ref: import("@codelia/shared-types").ImageArtifactRef,
	signal?: AbortSignal,
) => Promise<import("../types/llm/content").ImagePart>;

export type AgentServices = {
	resolveImage?: ResolveImage;
	/** Undefined shares the existing image store. Null disables copied-image resolution. */
	resolveAttachmentImage?: ResolveImage | null;
	modelMetadata?: ModelMetadataService;
	toolOutputCacheStore?: ToolOutputCacheStore | null;
	monotonicNowMs?: () => number;
	llmRetryNowMs?: () => number;
	llmRetryRandom?: () => number;
	llmRetrySleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};
