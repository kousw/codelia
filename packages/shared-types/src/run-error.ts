import { z } from "zod";
import { ProviderNameSchema } from "./provider";
import { wireInt } from "./wire";

/** Safe failure-only context for status notifications and retained errors. */
export const RunErrorInfoSchema = z
	.object({
		name: z.string(),
		message: z.string(),
		provider: ProviderNameSchema.optional(),
		kind: z.string().optional(),
		/** HTTP status, when the failure came from a provider response. */
		status: wireInt().optional(),
		code: z.string().optional(),
		attempts: wireInt().optional(),
		max_attempts: wireInt().optional(),
		detail: z.string().optional(),
		hint: z.string().optional(),
	})
	.meta({
		id: "RunErrorInfo",
		description:
			"Safe failure-only context for status notifications and retained errors.",
	});
export type RunErrorInfo = z.infer<typeof RunErrorInfoSchema>;
