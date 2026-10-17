import type { BaseMessage } from "./messages";
import type { LlmCallTiming } from "@codelia/shared-types";

export type ChatInvokeUsage = {
	model: string;
	provider_model?: string | null;
	input_tokens: number;
	input_cached_tokens?: number | null;
	input_cache_creation_tokens?: number | null;
	input_image_tokens?: number | null;
	output_tokens: number;
	output_reasoning_tokens?: number | null;
	total_tokens: number;
};

export type ChatInvokeCompletion = {
	messages: BaseMessage[];
	timing?: LlmCallTiming;
	usage?: ChatInvokeUsage | null;
	stop_reason?: string | null;
	provider_meta?: unknown;
};
