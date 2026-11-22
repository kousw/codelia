import { tagged } from "@codelia/shared-types";
import { z } from "zod";

export type ClientToolChoice = "auto" | "required" | "none" | string;

export type ClientToolDefinition = {
	type?: "function";
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	strict?: boolean;
	timeout_ms?: number;
	approval?: "default" | "never";
};

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
