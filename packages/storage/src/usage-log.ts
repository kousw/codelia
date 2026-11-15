import type { LlmResponseRecord, LlmUsageRecord } from "@codelia/core";

export const toUsageRecord = (
	record: LlmResponseRecord | LlmUsageRecord,
	sessionId?: string,
	model?: LlmUsageRecord["model"],
): LlmUsageRecord => {
	const usage = record.output.usage;
	return {
		type: "llm.usage",
		run_id: record.run_id,
		...(sessionId ? { session_id: sessionId } : {}),
		ts: record.ts,
		seq: record.seq,
		model: { provider: model?.provider, name: usage?.model ?? model?.name },
		output: {
			usage: usage
				? {
						model: usage.model,
						provider_model: usage.provider_model,
						input_tokens: usage.input_tokens,
						input_cached_tokens: usage.input_cached_tokens,
						input_cache_creation_tokens: usage.input_cache_creation_tokens,
						input_image_tokens: usage.input_image_tokens,
						output_tokens: usage.output_tokens,
						output_reasoning_tokens: usage.output_reasoning_tokens,
						total_tokens: usage.total_tokens,
					}
				: null,
			timing: record.output.timing
				? {
						time_to_first_token_ms: record.output.timing.time_to_first_token_ms,
						generation_duration_ms: record.output.timing.generation_duration_ms,
						generation_start_ms: record.output.timing.generation_start_ms,
						generation_start_source:
							record.output.timing.generation_start_source,
					}
				: undefined,
			stop_reason: record.output.stop_reason,
		},
	};
};
