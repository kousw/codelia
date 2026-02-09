// Client-side AgentEvent type definitions (duplicated from @codelia/core to avoid bundling issues)

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
	tool_call_id: string;
	display_name?: string;
};

export type ToolResultEvent = {
	type: "tool_result";
	tool: string;
	result: string;
	tool_call_id: string;
	is_error?: boolean;
};

export type StepCompleteEvent = {
	type: "step_complete";
	step_id: string;
	status: "completed" | "error";
	duration_ms: number;
};

export type FinalResponseEvent = {
	type: "final";
	content: string;
};

export type AgentEvent =
	| TextEvent
	| ReasoningEvent
	| StepStartEvent
	| ToolCallEvent
	| ToolResultEvent
	| StepCompleteEvent
	| FinalResponseEvent;

// API types

export type SessionSummary = {
	session_id: string;
	updated_at: string;
	message_count?: number;
	last_user_message?: string;
};

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	events: AgentEvent[];
	timestamp: number;
};
