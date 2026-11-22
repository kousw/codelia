import {
	ModelFastModeSchema,
	ModelReasoningLevelSchema,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";

export const ModelListParamsSchema = z
	.object({
		provider: z.string().optional(),
		include_details: z.boolean().optional(),
	})
	.meta({ id: "ModelListParams" });
export type ModelListParams = z.infer<typeof ModelListParamsSchema>;

export const ModelListDetailsSchema = z
	.object({
		release_date: z.string().optional(),
		context_window: wireInt().optional(),
		max_input_tokens: wireInt().optional(),
		max_output_tokens: wireInt().optional(),
		cost_per_1m_input_tokens_usd: z.number().optional(),
		cost_per_1m_output_tokens_usd: z.number().optional(),
	})
	.meta({ id: "ModelListDetails" });
export type ModelListDetails = z.infer<typeof ModelListDetailsSchema>;

/** Where the selected model comes from. */
export const ModelSelectionSourceSchema = z
	.enum(["config", "session"])
	.meta({ id: "ModelSelectionSource" });

export const ModelListResultSchema = z
	.object({
		providers: z.array(z.string()).optional(),
		/** Effort choices per model; an empty list means no reasoning picker. */
		reasoning_levels: z
			.record(z.string(), z.array(ModelReasoningLevelSchema))
			.optional(),
		provider: z.string(),
		models: z.array(z.string()),
		current: z.string().optional(),
		source: ModelSelectionSourceSchema.optional(),
		reasoning: ModelReasoningLevelSchema.optional(),
		fast: ModelFastModeSchema.optional(),
		details: z.record(z.string(), ModelListDetailsSchema).optional(),
	})
	.meta({ id: "ModelListResult" });
export type ModelListResult = z.infer<typeof ModelListResultSchema>;

export const ModelSetParamsSchema = z
	.object({
		name: z.string().optional(),
		provider: z.string().optional(),
		reasoning: ModelReasoningLevelSchema.optional(),
		fast: ModelFastModeSchema.optional(),
		scope: ModelSelectionSourceSchema.optional(),
		/** Clears the session-scope override. */
		reset: z.boolean().optional(),
	})
	.meta({ id: "ModelSetParams" });
export type ModelSetParams = z.infer<typeof ModelSetParamsSchema>;

export const ModelSetResultSchema = z
	.object({
		provider: z.string(),
		name: z.string(),
		source: ModelSelectionSourceSchema,
		reasoning: ModelReasoningLevelSchema.optional(),
		fast: ModelFastModeSchema.optional(),
	})
	.meta({ id: "ModelSetResult" });
export type ModelSetResult = z.infer<typeof ModelSetResultSchema>;
