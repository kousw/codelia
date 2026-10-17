import type { LlmResponseRecord } from "@codelia/core";
import type { RunMetricsNotify } from "@codelia/protocol";

export const buildRunMetrics = (
	record: LlmResponseRecord,
): RunMetricsNotify => {
	const timing = record.output.timing;
	const tokens = record.output.usage?.output_tokens;
	const duration = timing?.generation_duration_ms;
	const reasoning = record.output.usage?.output_reasoning_tokens;
	const matchedReasoning =
		reasoning === undefined ||
		reasoning === null ||
		(Number.isFinite(reasoning) &&
			reasoning >= 0 &&
			reasoning <= (tokens ?? 0) &&
			(reasoning === 0 ||
				(timing?.generation_start_source === "reasoning_item" &&
					typeof timing.generation_start_ms === "number")));
	const validTiming =
		timing &&
		Number.isFinite(timing.time_to_first_token_ms) &&
		timing.time_to_first_token_ms >= 0 &&
		typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration >= 0 &&
		(timing.generation_start_ms === undefined ||
			(Number.isFinite(timing.generation_start_ms) &&
				timing.generation_start_ms >= 0 &&
				timing.generation_start_ms <= timing.time_to_first_token_ms));
	const rate =
		validTiming &&
		matchedReasoning &&
		typeof tokens === "number" &&
		Number.isFinite(tokens) &&
		tokens >= 0 &&
		// Very short/batched streams do not expose a useful generation interval.
		duration >= 250
			? (tokens * 1000) / duration
			: null;
	return {
		run_id: record.run_id,
		seq: record.seq,
		output_tokens_per_second:
			rate !== null && Number.isFinite(rate) ? rate : null,
		...(validTiming ? { timing } : {}),
	};
};
