import { z } from "zod";
import { ContentPartSchema } from "./content";
import { ProviderNameSchema } from "./provider";
import { nullish, tagged, wireInt } from "./wire";

export const TextEventSchema = z
	.object({
		type: z.literal("text"),
		content: z.string(),
		timestamp: wireInt(),
	})
	.meta({ id: "TextEvent" });
export type TextEvent = z.infer<typeof TextEventSchema>;

export const ReasoningEventSchema = z
	.object({
		type: z.literal("reasoning"),
		content: z.string(),
		timestamp: wireInt(),
	})
	.meta({ id: "ReasoningEvent" });
export type ReasoningEvent = z.infer<typeof ReasoningEventSchema>;

/**
 * Provisional, ephemeral text streamed while one model call attempt is in progress.
 * `stream_id` identifies the attempt (a retried call gets a new id). `index` groups
 * provisional blocks of one kind within that stream, numbered in order of their
 * first delta; it does not identify a complete event. When the step's complete
 * events arrive, replace all provisional text of the `stream_id` with them; discard
 * it on `llm.retry` or when the run ends without them. Never persisted or replayed.
 * Opt-in via `ui_capabilities.supports_text_delta`. See ui-protocol.md §5.2.
 */
export const TextDeltaEventSchema = z
	.object({
		type: z.literal("text.delta"),
		delta: z.string(),
		stream_id: z.string(),
		index: wireInt(),
	})
	.meta({
		id: "TextDeltaEvent",
		description:
			"Provisional text of one model call attempt. Complete `text` events replace all provisional text of the same `stream_id`. Never persisted or replayed.",
	});
export type TextDeltaEvent = z.infer<typeof TextDeltaEventSchema>;

/** Reasoning counterpart of `TextDeltaEvent`; the complete `reasoning` event stays authoritative. */
export const ReasoningDeltaEventSchema = z
	.object({
		type: z.literal("reasoning.delta"),
		delta: z.string(),
		stream_id: z.string(),
		index: wireInt(),
	})
	.meta({
		id: "ReasoningDeltaEvent",
		description:
			"Reasoning counterpart of `TextDeltaEvent`; the complete `reasoning` event stays authoritative.",
	});
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;

export const LlmRetryEventSchema = z
	.object({
		type: z.literal("llm.retry"),
		provider: ProviderNameSchema,
		failure_kind: z.enum([
			"rate_limit",
			"overloaded",
			"timeout",
			"network",
			"provider",
		]),
		next_attempt: wireInt(),
		max_attempts: wireInt(),
		delay_ms: z.number(),
		delay_source: z.enum([
			"retry-after",
			"reset-header",
			"provider-body",
			"backoff",
		]),
		status: wireInt().optional(),
	})
	.meta({ id: "LlmRetryEvent" });
export type LlmRetryEvent = z.infer<typeof LlmRetryEventSchema>;

export const LlmStatusVerificationEventSchema = z
	.object({
		type: z.literal("llm.status"),
		// Open: receivers ignore statuses from providers they do not know.
		provider: z.enum(["openai"]),
		kind: z.literal("verification"),
		// Open: receivers ignore verification kinds they do not know.
		verification: z.enum(["trusted_access_for_cyber"]),
	})
	.meta({ id: "LlmStatusVerificationEvent" });

export const LlmStatusBufferingEventSchema = z
	.object({
		type: z.literal("llm.status"),
		// Open: receivers ignore statuses from providers they do not know.
		provider: z.enum(["openai"]),
		kind: z.literal("buffering"),
		active: z.boolean(),
		faster_model: z.string().optional(),
	})
	.meta({ id: "LlmStatusBufferingEvent" });

/** Informational provider status; never assistant history or model selection. */
export const LlmStatusEventSchema = tagged(
	"kind",
	[LlmStatusVerificationEventSchema, LlmStatusBufferingEventSchema],
	{
		id: "LlmStatusEvent",
		description:
			"Informational provider status; never assistant history or model selection.",
	},
);
export type LlmStatusEvent = z.infer<typeof LlmStatusEventSchema>;

export const StepStartEventSchema = z
	.object({
		type: z.literal("step_start"),
		step_id: z.string(),
		title: z.string(),
		step_number: wireInt(),
	})
	.meta({ id: "StepStartEvent" });
export type StepStartEvent = z.infer<typeof StepStartEventSchema>;

export const ToolCallEventSchema = z
	.object({
		type: z.literal("tool_call"),
		tool: z.string(),
		/** Tool-specific arguments; opaque to the protocol. */
		args: z.record(z.string(), z.unknown()),
		raw_args: z.string().optional(),
		tool_call_id: z.string(),
		display_name: z.string().optional(),
	})
	.meta({ id: "ToolCallEvent" });
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const ToolResultEventSchema = z
	.object({
		type: z.literal("tool_result"),
		tool: z.string(),
		/** Display text; clients parse it per tool. */
		result: z.string(),
		tool_call_id: z.string(),
		is_error: z.boolean().optional(),
		screenshot_base64: nullish(z.string()),
	})
	.meta({ id: "ToolResultEvent" });
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

export const PermissionPreviewEventSchema = z
	.object({
		type: z.literal("permission.preview"),
		tool: z.string(),
		tool_call_id: z.string().optional(),
		file_path: z.string().optional(),
		language: z.string().optional(),
		diff: z.string().optional(),
		summary: z.string().optional(),
		truncated: z.boolean().optional(),
	})
	.meta({ id: "PermissionPreviewEvent" });
export type PermissionPreviewEvent = z.infer<
	typeof PermissionPreviewEventSchema
>;

export const PermissionReadyEventSchema = z
	.object({
		type: z.literal("permission.ready"),
		tool: z.string(),
		tool_call_id: z.string().optional(),
	})
	.meta({ id: "PermissionReadyEvent" });
export type PermissionReadyEvent = z.infer<typeof PermissionReadyEventSchema>;

export const StepCompleteEventSchema = z
	.object({
		type: z.literal("step_complete"),
		step_id: z.string(),
		status: z.enum(["completed", "error"]),
		duration_ms: z.number(),
	})
	.meta({ id: "StepCompleteEvent" });
export type StepCompleteEvent = z.infer<typeof StepCompleteEventSchema>;

export const CompactionStartEventSchema = z
	.object({
		type: z.literal("compaction_start"),
		timestamp: wireInt(),
	})
	.meta({ id: "CompactionStartEvent" });
export type CompactionStartEvent = z.infer<typeof CompactionStartEventSchema>;

export const CompactionCompleteEventSchema = z
	.object({
		type: z.literal("compaction_complete"),
		timestamp: wireInt(),
		compacted: z.boolean(),
	})
	.meta({ id: "CompactionCompleteEvent" });
export type CompactionCompleteEvent = z.infer<
	typeof CompactionCompleteEventSchema
>;

export const HiddenUserMessageEventSchema = z
	.object({
		type: z.literal("hidden_user_message"),
		content: z.string(),
	})
	.meta({ id: "HiddenUserMessageEvent" });
export type HiddenUserMessageEvent = z.infer<
	typeof HiddenUserMessageEventSchema
>;

export const SteerAppliedEventSchema = z
	.object({
		type: z.literal("steer_applied"),
		steer_id: z.string(),
		content: z.union([z.string(), z.array(ContentPartSchema)]),
		timestamp: wireInt(),
	})
	.meta({ id: "SteerAppliedEvent" });
export type SteerAppliedEvent = z.infer<typeof SteerAppliedEventSchema>;

export const FinalResponseEventSchema = z
	.object({
		type: z.literal("final"),
		content: z.string(),
		termination_reason: z
			.enum(["normal", "max_steps", "permission_denied"])
			.optional(),
	})
	.meta({ id: "FinalResponseEvent" });
export type FinalResponseEvent = z.infer<typeof FinalResponseEventSchema>;

/** Persisted and replayed: new variants and optional fields only. */
export const AgentEventSchema = tagged(
	"type",
	[
		TextEventSchema,
		ReasoningEventSchema,
		TextDeltaEventSchema,
		ReasoningDeltaEventSchema,
		LlmRetryEventSchema,
		LlmStatusEventSchema,
		StepStartEventSchema,
		ToolCallEventSchema,
		ToolResultEventSchema,
		PermissionPreviewEventSchema,
		PermissionReadyEventSchema,
		StepCompleteEventSchema,
		CompactionStartEventSchema,
		CompactionCompleteEventSchema,
		HiddenUserMessageEventSchema,
		SteerAppliedEventSchema,
		FinalResponseEventSchema,
	],
	{
		id: "AgentEvent",
		description:
			"Persisted and replayed: add variants and optional fields only.",
	},
);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
