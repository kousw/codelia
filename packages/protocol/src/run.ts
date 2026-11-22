import {
	AgentEventSchema,
	ImageUrlSchema,
	LlmCallTimingSchema,
	RunErrorInfoSchema,
	tagged,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";
import type { ClientToolChoice, ClientToolDefinition } from "./client-tools";
import type { UiContextSnapshot } from "./ui-context";

export const RunInputTextSchema = z
	.object({ type: z.literal("text"), text: z.string() })
	.meta({ id: "RunInputText" });
export type RunInputText = z.infer<typeof RunInputTextSchema>;

export const RunInputTextPartSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.meta({ id: "RunInputTextPart" });
export type RunInputTextPart = z.infer<typeof RunInputTextPartSchema>;

export const RunInputImagePartSchema = z
	.object({
		type: z.literal("image_url"),
		image_url: ImageUrlSchema,
	})
	.meta({ id: "RunInputImagePart" });
export type RunInputImagePart = z.infer<typeof RunInputImagePartSchema>;

export const RunInputAttachmentPartSchema = z
	.object({
		type: z.literal("attachment_ref"),
		attachment_id: z.string(),
	})
	.meta({ id: "RunInputAttachmentPart" });
export type RunInputAttachmentPart = z.infer<
	typeof RunInputAttachmentPartSchema
>;

export const RunInputPartSchema = tagged(
	"type",
	[
		RunInputTextPartSchema,
		RunInputImagePartSchema,
		RunInputAttachmentPartSchema,
	],
	{ id: "RunInputPart" },
);

export const RunInputPartsSchema = z
	.object({
		type: z.literal("parts"),
		parts: z.array(RunInputPartSchema),
	})
	.meta({ id: "RunInputParts" });
export type RunInputParts = z.infer<typeof RunInputPartsSchema>;

export const RunInputSchema = tagged(
	"type",
	[RunInputTextSchema, RunInputPartsSchema],
	{ id: "RunInput" },
);
export type RunInput = z.infer<typeof RunInputSchema>;

export type RunStartParams = {
	input: RunInput;
	session_id?: string;
	force_compaction?: boolean;
	tools?: ClientToolDefinition[];
	tool_choice?: ClientToolChoice;
	ui_context?: UiContextSnapshot;
	meta?: Record<string, unknown>;
};

export type RunStartResult = {
	run_id: string;
	session_id?: string;
	session_log_path?: string;
};

export const AgentEventNotifySchema = z
	.object({
		run_id: z.string(),
		seq: wireInt(),
		event: AgentEventSchema,
		/** Open extension object; `session.history` sets `replayed: true`. */
		meta: z.looseObject({ replayed: z.boolean().optional() }).optional(),
	})
	.meta({ id: "AgentEventNotify" });
export type AgentEventNotify = z.infer<typeof AgentEventNotifySchema>;

export type RunCancelParams = {
	run_id: string;
	reason?: string;
};

export const RunSteerParamsSchema = z
	.object({
		run_id: z.string(),
		input: RunInputSchema,
		client_steer_id: z.string().optional(),
	})
	.meta({ id: "RunSteerParams" });
export type RunSteerParams = z.infer<typeof RunSteerParamsSchema>;

export const RunSteerResultSchema = z
	.object({
		ok: z.literal(true),
		steer_id: z.string(),
	})
	.meta({ id: "RunSteerResult" });
export type RunSteerResult = z.infer<typeof RunSteerResultSchema>;

export const RunStatusSchema = z
	.enum(["running", "awaiting_ui", "completed", "error", "cancelled"])
	.meta({ id: "RunStatus" });
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunStatusNotifySchema = z
	.object({
		run_id: z.string(),
		status: RunStatusSchema,
		message: z.string().optional(),
		/** Failure-only structured context, without raw provider data. */
		error: RunErrorInfoSchema.optional(),
		unconsumed_steer_ids: z.array(z.string()).optional(),
	})
	.meta({ id: "RunStatusNotify" });
export type RunStatusNotify = z.infer<typeof RunStatusNotifySchema>;

export type RunContextNotify = {
	run_id: string;
	context_left_percent: number;
};

export type RunUsageSummary = {
	total_calls: number;
	total_tokens: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_cached_input_tokens: number;
	total_cache_creation_tokens: number;
	total_cost_usd?: number | null;
	by_model: Record<
		string,
		{
			calls: number;
			input_tokens: number;
			output_tokens: number;
			cached_input_tokens: number;
			cache_creation_tokens: number;
			total_tokens: number;
			cost_usd?: number | null;
		}
	>;
};

export type CacheHitState = "hit" | "miss" | "unknown";

/** Latest completed model call; emitted independently of diagnostics mode. */
export const RunMetricsNotifySchema = z
	.object({
		run_id: z.string(),
		seq: wireInt(),
		/** Always sent; `null` clears the last known rate. */
		output_tokens_per_second: z.number().nullable(),
		timing: LlmCallTimingSchema.optional(),
	})
	.meta({
		id: "RunMetricsNotify",
		description:
			"Latest completed model call; emitted independently of diagnostics mode.",
	});
export type RunMetricsNotify = z.infer<typeof RunMetricsNotifySchema>;

export type LlmCallDiagnostics = {
	run_id: string;
	seq: number;
	provider?: string;
	model: string;
	request_ts: string;
	response_ts: string;
	latency_ms: number;
	timing?: import("@codelia/shared-types").LlmCallTiming;
	output_tokens_per_second?: number | null;
	stop_reason?: string | null;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		output_reasoning_tokens?: number | null;
		total_tokens: number;
		input_cached_tokens?: number | null;
		input_cache_creation_tokens?: number | null;
		input_image_tokens?: number | null;
	} | null;
	cache: {
		hit_state: CacheHitState;
		cache_read_tokens: number;
		cache_creation_tokens: number;
		cache_read_ratio?: number | null;
	};
	cost_usd?: number | null;
	provider_meta_summary?: string | null;
};

export type RunDiagnosticsNotify =
	| {
			run_id: string;
			kind: "llm_call";
			call: LlmCallDiagnostics;
	  }
	| {
			run_id: string;
			kind: "run_summary";
			summary: RunUsageSummary;
	  };
