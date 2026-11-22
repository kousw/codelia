import { z } from "zod";
import { wireInt } from "./wire";

export const ContextUsageCategorySchema = z
	.enum(["system", "tools", "messages", "tool_results", "images"])
	.meta({ id: "ContextUsageCategory" });
export type ContextUsageCategory = z.infer<typeof ContextUsageCategorySchema>;

export const ContextUsageBreakdownEntrySchema = z
	.object({
		category: ContextUsageCategorySchema,
		/** Estimated tokens of the current history in this category. */
		tokens: wireInt(),
		/** Number of items (images only). */
		count: wireInt().optional(),
	})
	.meta({ id: "ContextUsageBreakdownEntry" });
export type ContextUsageBreakdownEntry = z.infer<
	typeof ContextUsageBreakdownEntrySchema
>;

/** Context window usage of one agent; produced by core, sent by runtime. */
export const ContextUsageSchema = z
	.object({
		/** Null only when no agent has been built yet. */
		provider: z.string().nullable(),
		model: z.string().nullable(),
		/** Model input limit (`maxInputTokens ?? contextWindow`); null when unknown. */
		limit_tokens: wireInt().nullable(),
		/** Last provider-reported `total_tokens` (same basis as `left_percent`). */
		used_tokens: wireInt().nullable(),
		/** Last provider-reported `input_tokens`. */
		input_tokens: wireInt().nullable(),
		left_percent: z.number().nullable(),
		/** `provider`: used/input come from the last model call; `none`: no call yet. */
		basis: z.enum(["provider", "none"]),
		/**
		 * Size estimate of the current history and tool definitions by category
		 * (serialized bytes / 3; images via the model's image-token estimate). Not
		 * normalized to `used_tokens`, which stays provider-reported only.
		 */
		breakdown: z.array(ContextUsageBreakdownEntrySchema),
	})
	.meta({ id: "ContextUsage" });
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
