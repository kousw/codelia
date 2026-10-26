import { parseResponsesProviders } from "@codelia/config";
import { MODEL_REASONING_LEVELS } from "@codelia/shared-types";
import { z } from "zod";

export const subagentModelSchema = z
	.object({
		provider: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
		providers: z
			.unknown()
			.optional()
			.transform((value) =>
				value === undefined
					? undefined
					: parseResponsesProviders(value, "subagent bootstrap"),
			),
		name: z.string().min(1),
		reasoning: z.string().optional(),
		verbosity: z.string().optional(),
		fast: z
			.union([z.boolean(), z.literal("ultrafast")])
			.optional()
			.describe(
				'Optional speed selection. true uses supported fast mode; "ultrafast" requires OpenAI API-key GPT-6 Astra/6.1 Sol and higher API pricing. No auth or tier fallback.',
			),
		experimental: z
			.object({
				openai: z
					.object({
						websocket_mode: z.enum(["off", "auto", "on"]).optional(),
					})
					.optional(),
			})
			.optional(),
	})
	.strict();

export const subagentModelSelectionSchema = subagentModelSchema
	.omit({ experimental: true, providers: true })
	.extend({
		provider: subagentModelSchema.shape.provider
			.optional()
			.describe("Provider to use; omitted uses the parent provider."),
		name: z
			.string()
			.trim()
			.min(1)
			.max(256)
			.describe(
				"Exact model id requested by the user. No model-catalog lookup is performed.",
			),
		reasoning: z
			.enum(MODEL_REASONING_LEVELS)
			.optional()
			.describe(
				"Optional reasoning strength; omitted uses the selected model's runtime default.",
			),
		verbosity: z.enum(["low", "medium", "high"]).optional(),
	});
