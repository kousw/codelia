import type { BaseMessage } from "./messages";

export type ChatInvokeUsage = {
	model: string;
	input_tokens: number;
	input_cached_tokens?: number | null;
	input_cache_creation_tokens?: number | null;
	input_image_tokens?: number | null;
	output_tokens: number;
	total_tokens: number;
};

export type ChatInvokeCompletion = {
	messages: BaseMessage[];
	usage?: ChatInvokeUsage | null;
	stop_reason?: string | null;
	provider_meta?: unknown;
};
