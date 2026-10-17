/** Observed successful stream timing, measured with a monotonic clock. */
export type LlmCallTiming = {
	time_to_first_token_ms: number;
	generation_duration_ms: number;
	/** Optional observed start of hidden reasoning, distinct from first delta. */
	generation_start_ms?: number;
	generation_start_source?: "reasoning_item";
};
