import type { ProviderName } from "./provider";

export type TextEvent = {
	type: "text";
	content: string;
	timestamp: number;
};

export type ReasoningEvent = {
	type: "reasoning";
	content: string;
	timestamp: number;
};

/**
 * Provisional, ephemeral text streamed while one model call attempt is in progress.
 * `stream_id` identifies the attempt (a retried call gets a new id); `index` is the
 * position of the text block within that response. Never persisted or replayed; the
 * complete `text` / `final` events remain authoritative. Opt-in via
 * `ui_capabilities.supports_text_delta`.
 */
export type TextDeltaEvent = {
	type: "text.delta";
	delta: string;
	stream_id: string;
	index: number;
};

/** Reasoning counterpart of `TextDeltaEvent`; the complete `reasoning` event stays authoritative. */
export type ReasoningDeltaEvent = {
	type: "reasoning.delta";
	delta: string;
	stream_id: string;
	index: number;
};

export type LlmRetryEvent = {
	type: "llm.retry";
	provider: ProviderName;
	failure_kind:
		| "rate_limit"
		| "overloaded"
		| "timeout"
		| "network"
		| "provider";
	next_attempt: number;
	max_attempts: number;
	delay_ms: number;
	delay_source: "retry-after" | "reset-header" | "provider-body" | "backoff";
	status?: number;
};

/** Informational provider status; never assistant history or model selection. */
export type LlmStatusEvent =
	| {
			type: "llm.status";
			provider: "openai";
			kind: "verification";
			verification: "trusted_access_for_cyber";
	  }
	| {
			type: "llm.status";
			provider: "openai";
			kind: "buffering";
			active: boolean;
			faster_model?: string;
	  };

export type StepStartEvent = {
	type: "step_start";
	step_id: string;
	title: string;
	step_number: number;
};

export type ToolCallEvent = {
	type: "tool_call";
	tool: string;
	args: Record<string, unknown>;
	raw_args?: string;
	tool_call_id: string;
	display_name?: string;
};

export type ToolResultEvent = {
	type: "tool_result";
	tool: string;
	result: string;
	tool_call_id: string;
	is_error?: boolean;
	screenshot_base64?: string | null;
};

export type PermissionPreviewEvent = {
	type: "permission.preview";
	tool: string;
	tool_call_id?: string;
	file_path?: string;
	language?: string;
	diff?: string;
	summary?: string;
	truncated?: boolean;
};

export type PermissionReadyEvent = {
	type: "permission.ready";
	tool: string;
	tool_call_id?: string;
};

export type StepCompleteEvent = {
	type: "step_complete";
	step_id: string;
	status: "completed" | "error";
	duration_ms: number;
};

export type CompactionStartEvent = {
	type: "compaction_start";
	timestamp: number;
};

export type CompactionCompleteEvent = {
	type: "compaction_complete";
	timestamp: number;
	compacted: boolean;
};

export type HiddenUserMessageEvent = {
	type: "hidden_user_message";
	content: string;
};

export type FinalResponseEvent = {
	type: "final";
	content: string;
	termination_reason?: "normal" | "max_steps" | "permission_denied";
};

export type AgentEvent =
	| TextEvent
	| ReasoningEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| LlmRetryEvent
	| LlmStatusEvent
	| StepStartEvent
	| ToolCallEvent
	| ToolResultEvent
	| PermissionPreviewEvent
	| PermissionReadyEvent
	| StepCompleteEvent
	| CompactionStartEvent
	| CompactionCompleteEvent
	| HiddenUserMessageEvent
	| FinalResponseEvent;
