import { z } from "zod";

/** Observed successful stream timing, measured with a monotonic clock. */
export const LlmCallTimingSchema = z
	.object({
		time_to_first_token_ms: z.number(),
		generation_duration_ms: z.number(),
		/** Optional observed start of hidden reasoning, distinct from first delta. */
		generation_start_ms: z.number().optional(),
		generation_start_source: z
			.enum(["reasoning_item", "thought_step"])
			.optional(),
	})
	.meta({
		id: "LlmCallTiming",
		description:
			"Observed successful stream timing, measured with a monotonic clock.",
	});
export type LlmCallTiming = z.infer<typeof LlmCallTimingSchema>;
