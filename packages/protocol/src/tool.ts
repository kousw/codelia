import { z } from "zod";

export const ToolCallParamsSchema = z
	.object({
		name: z.string(),
		/** Tool-specific arguments; opaque to the protocol. */
		arguments: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "ToolCallParams" });
export type ToolCallParams = z.infer<typeof ToolCallParamsSchema>;

export const ToolCallResultSchema = z
	.object({
		ok: z.boolean(),
		/** Tool output; any JSON value, opaque to the protocol. */
		result: z.unknown(),
	})
	.meta({ id: "ToolCallResult" });
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
