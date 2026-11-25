import {
	AgentEventSchema,
	ImageUrlSchema,
	LlmCallTimingSchema,
	nullish,
	RunErrorInfoSchema,
	tagged,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";
import {
	ClientToolChoiceSchema,
	ClientToolDefinitionSchema,
} from "./client-tools";
import { UiContextSnapshotSchema } from "./ui-context";

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

export const RunStartParamsSchema = z
	.object({
		input: RunInputSchema,
		session_id: z.string().optional(),
		force_compaction: z.boolean().optional(),
		/** Client-provided tools for this run (`client.tool.call`). */
		tools: z.array(ClientToolDefinitionSchema).optional(),
		tool_choice: ClientToolChoiceSchema.optional(),
		ui_context: UiContextSnapshotSchema.optional(),
		/** Open extension object. */
		meta: z.record(z.string(), z.unknown()).optional(),
	})
	.meta({ id: "RunStartParams" });
export type RunStartParams = z.infer<typeof RunStartParamsSchema>;

export const RunStartResultSchema = z
	.object({
		run_id: z.string(),
		session_id: z.string().optional(),
		session_log_path: z.string().optional(),
	})
	.meta({ id: "RunStartResult" });
export type RunStartResult = z.infer<typeof RunStartResultSchema>;

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

export const RunCancelParamsSchema = z
	.object({
		run_id: z.string(),
		reason: z.string().optional(),
	})
	.meta({ id: "RunCancelParams" });
export type RunCancelParams = z.infer<typeof RunCancelParamsSchema>;

export const RunCancelResultSchema = z
	.object({ ok: z.literal(true) })
	.meta({ id: "RunCancelResult" });
export type RunCancelResult = z.infer<typeof RunCancelResultSchema>;

const ClientSteerIdSchema = z.string().optional();

export const RunSteerParamsSchema = z
	.object({
		run_id: z.string(),
		input: RunInputSchema,
		client_steer_id: ClientSteerIdSchema,
	})
	.meta({ id: "RunSteerParams" });
export type RunSteerParams = z.infer<typeof RunSteerParamsSchema>;

export const RunSteerResultSchema = z
	.object({
		ok: z.literal(true),
		steer_id: z.string(),
		client_steer_id: ClientSteerIdSchema,
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
		unconsumed_client_steer_ids: z.array(z.string()).optional(),
	})
	.meta({ id: "RunStatusNotify" });
export type RunStatusNotify = z.infer<typeof RunStatusNotifySchema>;

export const RunContextNotifySchema = z
	.object({
		run_id: z.string(),
		context_left_percent: z.number(),
	})
	.meta({ id: "RunContextNotify" });
export type RunContextNotify = z.infer<typeof RunContextNotifySchema>;

export const RunUsageByModelSchema = z
	.object({
		calls: wireInt(),
		input_tokens: wireInt(),
		output_tokens: wireInt(),
		cached_input_tokens: wireInt(),
		cache_creation_tokens: wireInt(),
		total_tokens: wireInt(),
		/** Absent and `null` both mean the cost is unknown. */
		cost_usd: nullish(z.number()),
	})
	.meta({ id: "RunUsageByModel" });

export const RunUsageSummarySchema = z
	.object({
		total_calls: wireInt(),
		total_tokens: wireInt(),
		total_input_tokens: wireInt(),
		total_output_tokens: wireInt(),
		total_cached_input_tokens: wireInt(),
		total_cache_creation_tokens: wireInt(),
		/** Absent and `null` both mean the cost is unknown. */
		total_cost_usd: nullish(z.number()),
		by_model: z.record(z.string(), RunUsageByModelSchema),
	})
	.meta({ id: "RunUsageSummary" });
export type RunUsageSummary = z.infer<typeof RunUsageSummarySchema>;

export const CacheHitStateSchema = z
	.enum(["hit", "miss", "unknown"])
	.meta({ id: "CacheHitState" });
export type CacheHitState = z.infer<typeof CacheHitStateSchema>;

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

export const LlmCallDiagnosticsUsageSchema = z
	.object({
		input_tokens: wireInt(),
		output_tokens: wireInt(),
		output_reasoning_tokens: nullish(wireInt()),
		total_tokens: wireInt(),
		input_cached_tokens: nullish(wireInt()),
		input_cache_creation_tokens: nullish(wireInt()),
		input_image_tokens: nullish(wireInt()),
	})
	.meta({ id: "LlmCallDiagnosticsUsage" });

export const LlmCallDiagnosticsCacheSchema = z
	.object({
		hit_state: CacheHitStateSchema,
		cache_read_tokens: wireInt(),
		cache_creation_tokens: wireInt(),
		cache_read_ratio: nullish(z.number()),
	})
	.meta({ id: "LlmCallDiagnosticsCache" });

export const LlmCallDiagnosticsSchema = z
	.object({
		run_id: z.string(),
		seq: wireInt(),
		provider: z.string().optional(),
		model: z.string(),
		request_ts: z.string(),
		response_ts: z.string(),
		latency_ms: z.number(),
		timing: LlmCallTimingSchema.optional(),
		output_tokens_per_second: nullish(z.number()),
		stop_reason: nullish(z.string()),
		/** Absent and `null` both mean usage was not reported. */
		usage: nullish(LlmCallDiagnosticsUsageSchema),
		cache: LlmCallDiagnosticsCacheSchema,
		cost_usd: nullish(z.number()),
		provider_meta_summary: nullish(z.string()),
	})
	.meta({ id: "LlmCallDiagnostics" });
export type LlmCallDiagnostics = z.infer<typeof LlmCallDiagnosticsSchema>;

export const RunDiagnosticsLlmCallSchema = z
	.object({
		run_id: z.string(),
		kind: z.literal("llm_call"),
		call: LlmCallDiagnosticsSchema,
	})
	.meta({ id: "RunDiagnosticsLlmCall" });

export const RunDiagnosticsRunSummarySchema = z
	.object({
		run_id: z.string(),
		kind: z.literal("run_summary"),
		summary: RunUsageSummarySchema,
	})
	.meta({ id: "RunDiagnosticsRunSummary" });

/** Only sent with `CODELIA_DIAGNOSTICS=1` or `ui_capabilities.supports_run_diagnostics`; never persisted. */
export const RunDiagnosticsNotifySchema = tagged(
	"kind",
	[RunDiagnosticsLlmCallSchema, RunDiagnosticsRunSummarySchema],
	{ id: "RunDiagnosticsNotify" },
);
export type RunDiagnosticsNotify = z.infer<typeof RunDiagnosticsNotifySchema>;
