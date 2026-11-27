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

export const TelemetryModelUsageSchema = z
	.object({
		calls: wireInt(),
		input_tokens: wireInt(),
		output_tokens: wireInt(),
		output_reasoning_tokens: wireInt(),
		cached_input_tokens: wireInt(),
		cache_creation_tokens: wireInt(),
		input_image_tokens: wireInt(),
		cache_hit_calls: wireInt(),
		cache_miss_calls: wireInt(),
		cache_unknown_calls: wireInt(),
		total_tokens: wireInt(),
		/** Absent and `null` both mean the cost is unknown. */
		cost_usd: nullish(z.number()),
	})
	.meta({ id: "TelemetryModelUsage" });
export type TelemetryModelUsage = z.infer<typeof TelemetryModelUsageSchema>;

export const TelemetrySummarySchema = z
	.object({
		total_calls: wireInt(),
		total_tokens: wireInt(),
		total_input_tokens: wireInt(),
		total_output_tokens: wireInt(),
		total_output_reasoning_tokens: wireInt(),
		total_cached_input_tokens: wireInt(),
		total_cache_creation_tokens: wireInt(),
		total_input_image_tokens: wireInt(),
		cache_hit_calls: wireInt(),
		cache_miss_calls: wireInt(),
		cache_unknown_calls: wireInt(),
		/** Absent and `null` both mean the cost is unknown. */
		total_cost_usd: nullish(z.number()),
		retry_count: wireInt(),
		retry_wait_ms: z.number(),
		tool_calls: wireInt(),
		tool_errors: wireInt(),
		tool_exec_ms: z.number(),
		tool_approval_wait_ms: z.number(),
		compaction_count: wireInt(),
		compaction_duration_ms: z.number(),
		by_model: z.record(z.string(), TelemetryModelUsageSchema),
	})
	.meta({ id: "TelemetrySummary" });
export type TelemetrySummary = z.infer<typeof TelemetrySummarySchema>;

export const CacheHitStateSchema = z
	.enum(["hit", "miss", "unknown"])
	.meta({ id: "CacheHitState" });
export type CacheHitState = z.infer<typeof CacheHitStateSchema>;

export const CostBasisSchema = z
	.enum(["api_list", "unavailable"])
	.meta({ id: "CostBasis" });
export type CostBasis = z.infer<typeof CostBasisSchema>;

export const LlmCallUsageSchema = z
	.object({
		input_tokens: wireInt(),
		output_tokens: wireInt(),
		output_reasoning_tokens: nullish(wireInt()),
		total_tokens: wireInt(),
		input_cached_tokens: nullish(wireInt()),
		input_cache_creation_tokens: nullish(wireInt()),
		input_image_tokens: nullish(wireInt()),
	})
	.meta({ id: "LlmCallUsage" });
export type LlmCallUsage = z.infer<typeof LlmCallUsageSchema>;

export const LlmCallCacheSchema = z
	.object({
		hit_state: CacheHitStateSchema,
		cache_read_tokens: wireInt(),
		cache_creation_tokens: wireInt(),
		cache_read_ratio: nullish(z.number()),
	})
	.meta({ id: "LlmCallCache" });
export type LlmCallCache = z.infer<typeof LlmCallCacheSchema>;

export const RunContextSnapshotSchema = z
	.object({
		limit_tokens: wireInt().nullable(),
		used_tokens: wireInt().nullable(),
		input_tokens: wireInt().nullable(),
		left_percent: z.number().nullable(),
		basis: z.enum(["provider_usage", "estimate", "none"]),
	})
	.meta({ id: "RunContextSnapshot" });
export type RunContextSnapshot = z.infer<typeof RunContextSnapshotSchema>;

/**
 * Always-on per-LLM-call structured telemetry emitted after each completed model call.
 * Clients retain the last known TPS when `output_tokens_per_second` is `null`.
 */
export const RunMetricsNotifySchema = z
	.object({
		run_id: z.string(),
		seq: wireInt(),
		provider: z.string().optional(),
		model: z.string().optional(),
		actual_model: nullish(z.string()),
		request_ts: z.string().optional(),
		response_ts: z.string().optional(),
		latency_ms: z.number().optional(),
		/** Observed generation TPS; `null` when unavailable (clients keep last measured rate). */
		output_tokens_per_second: z.number().nullable(),
		timing: LlmCallTimingSchema.optional(),
		stop_reason: nullish(z.string()),
		/** Absent and `null` both mean usage was not reported. */
		usage: nullish(LlmCallUsageSchema),
		cache: LlmCallCacheSchema.optional(),
		cost_usd: nullish(z.number()),
		cost_basis: CostBasisSchema.optional(),
		retry_count: wireInt().optional(),
		retry_wait_ms: z.number().optional(),
		provider_meta_summary: nullish(z.string()),
		context: RunContextSnapshotSchema.optional(),
	})
	.meta({
		id: "RunMetricsNotify",
		description:
			"Always-on structured telemetry for each completed model call.",
	});
export type RunMetricsNotify = z.infer<typeof RunMetricsNotifySchema>;

/** Always-on terminal summary emitted when a run completes, cancels, or errors. */
export const RunSummaryNotifySchema = z
	.object({
		run_id: z.string(),
		duration_ms: z.number(),
		run: TelemetrySummarySchema,
		session: TelemetrySummarySchema,
	})
	.meta({
		id: "RunSummaryNotify",
		description:
			"Always-on terminal run and cumulative session telemetry summary.",
	});
export type RunSummaryNotify = z.infer<typeof RunSummaryNotifySchema>;
