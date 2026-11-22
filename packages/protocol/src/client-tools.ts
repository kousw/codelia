import { tagged, wireInt } from "@codelia/shared-types";
import { z } from "zod";

/** `auto`, `required`, `none`, or the name of one tool. */
export const ClientToolChoiceSchema = z
	.string()
	.meta({ id: "ClientToolChoice" });
export type ClientToolChoice = z.infer<typeof ClientToolChoiceSchema>;

export const ClientToolApprovalSchema = z
	.enum(["default", "never"])
	.meta({ id: "ClientToolApproval" });

export const ClientToolDefinitionSchema = z
	.object({
		type: z.literal("function").optional(),
		name: z.string(),
		description: z.string(),
		/** JSON Schema of the tool arguments. */
		parameters: z.record(z.string(), z.unknown()),
		strict: z.boolean().optional(),
		timeout_ms: wireInt().optional(),
		approval: ClientToolApprovalSchema.optional(),
	})
	.meta({ id: "ClientToolDefinition" });
export type ClientToolDefinition = z.infer<typeof ClientToolDefinitionSchema>;

export const ClientToolCallRequestParamsSchema = z
	.object({
		run_id: z.string(),
		name: z.string(),
		/** Parsed model arguments; opaque to the protocol. */
		arguments: z.record(z.string(), z.unknown()).optional(),
		raw_arguments: z.string(),
	})
	.meta({ id: "ClientToolCallRequestParams" });
export type ClientToolCallRequestParams = z.infer<
	typeof ClientToolCallRequestParamsSchema
>;

export const ClientToolCancelParamsSchema = z
	.object({
		/** Id of the `client.tool.call` request being withdrawn. */
		request_id: z.string(),
		run_id: z.string(),
		name: z.string(),
		reason: z.enum(["timeout"]),
	})
	.meta({ id: "ClientToolCancelParams" });
export type ClientToolCancelParams = z.infer<
	typeof ClientToolCancelParamsSchema
>;

export type ClientToolStructuredResult =
	| { type: "text"; text: string }
	| { type: "json"; value: unknown }
	| { type: "parts"; parts: unknown[] };

export type ClientToolResultValue =
	| string
	| number
	| boolean
	| null
	| ClientToolStructuredResult
	| Record<string, unknown>
	| unknown[];

export const ClientToolCallSuccessSchema = z
	.object({
		ok: z.literal(true),
		/**
		 * Tool output; any JSON value (see `ClientToolResultValue`). Opaque to
		 * the protocol and normalized by the runtime.
		 */
		result: z.unknown().optional(),
	})
	.meta({ id: "ClientToolCallSuccess" });

export const ClientToolCallFailureSchema = z
	.object({
		ok: z.literal(false),
		error: z.string(),
	})
	.meta({ id: "ClientToolCallFailure" });

export const ClientToolCallResultSchema = tagged(
	"ok",
	[ClientToolCallSuccessSchema, ClientToolCallFailureSchema],
	{ id: "ClientToolCallResult" },
);
export type ClientToolCallResult = z.infer<typeof ClientToolCallResultSchema>;
