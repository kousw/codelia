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
	file_path?: string;
	language?: string;
	diff?: string;
	summary?: string;
	truncated?: boolean;
};

export type PermissionReadyEvent = {
	type: "permission.ready";
	tool: string;
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
};

export type AgentEvent =
	| TextEvent
	| ReasoningEvent
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
