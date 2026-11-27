import { ContextUsageSchema, wireInt } from "@codelia/shared-types";
import { z } from "zod";
import { RunMetricsNotifySchema, TelemetrySummarySchema } from "./run";

export const TelemetryGetParamsSchema = z
	.object({})
	.strict()
	.meta({ id: "TelemetryGetParams" });
export type TelemetryGetParams = z.infer<typeof TelemetryGetParamsSchema>;

export const ToolTimingRecordSchema = z
	.object({
		run_id: z.string(),
		tool_call_id: z.string(),
		tool: z.string(),
		status: z.enum(["completed", "error"]),
		duration_ms: z.number(),
		exec_duration_ms: z.number().optional(),
		approval_wait_ms: z.number().optional(),
		finished_at: z.string(),
	})
	.meta({ id: "ToolTimingRecord" });
export type ToolTimingRecord = z.infer<typeof ToolTimingRecordSchema>;

export const RuntimePerfPhaseSchema = z
	.object({
		name: z.string(),
		duration_ms: z.number(),
	})
	.meta({ id: "RuntimePerfPhase" });
export type RuntimePerfPhase = z.infer<typeof RuntimePerfPhaseSchema>;

export const RuntimeMemoryUsageSchema = z
	.object({
		rss_bytes: wireInt(),
		heap_used_bytes: wireInt(),
		heap_total_bytes: wireInt(),
		external_bytes: wireInt(),
		array_buffers_bytes: wireInt(),
	})
	.meta({ id: "RuntimeMemoryUsage" });
export type RuntimeMemoryUsage = z.infer<typeof RuntimeMemoryUsageSchema>;

export const RuntimePerfSnapshotSchema = z
	.object({
		startup_phases: z.array(RuntimePerfPhaseSchema),
		agent_init_phases: z.array(RuntimePerfPhaseSchema),
		active_subagents: wireInt(),
		max_concurrent_subagents: wireInt(),
		backpressure_events: wireInt(),
		memory: RuntimeMemoryUsageSchema,
	})
	.meta({ id: "RuntimePerfSnapshot" });
export type RuntimePerfSnapshot = z.infer<typeof RuntimePerfSnapshotSchema>;

/** Read-only snapshot of live session/run telemetry, context usage, and runtime perf. */
export const TelemetryGetResultSchema = z
	.object({
		session_id: z.string().optional(),
		active_run_id: z.string().nullable(),
		context: ContextUsageSchema,
		session_summary: TelemetrySummarySchema,
		run_summary: TelemetrySummarySchema.nullable(),
		recent_calls: z.array(RunMetricsNotifySchema),
		recent_tools: z.array(ToolTimingRecordSchema),
		runtime: RuntimePerfSnapshotSchema,
	})
	.meta({ id: "TelemetryGetResult" });
export type TelemetryGetResult = z.infer<typeof TelemetryGetResultSchema>;
