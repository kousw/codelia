import type { SessionStateSummary as SharedSessionStateSummary } from "@codelia/shared-types";
import type { AgentEvent } from "./events";
import type { ChatInvokeUsage } from "./llm/invoke";
import type { BaseMessage, ToolOutputRef } from "./llm/messages";
import type { ToolChoice, ToolDefinition } from "./llm/tools";

export type SessionHeader = {
	type: "header";
	schema_version: 1;
	run_id: string;
	session_id?: string;
	started_at: string;
	client?: { name: string; version: string };
	server?: { name: string; version: string };
	model?: { provider?: string; name?: string; reasoning?: string };
	prompts?: { system?: string };
	tools?: { definitions?: ToolDefinition[]; source?: string };
	runtime?: { cwd?: string; os?: string; arch?: string; version?: string };
	meta?: Record<string, unknown>;
};

export type RunStartRecord = {
	type: "run.start";
	run_id: string;
	session_id?: string;
	ts: string;
	input: { type: "text"; text: string };
	ui_context?: unknown;
	meta?: Record<string, unknown>;
};

export type RunContextRecord = {
	type: "run.context";
	run_id: string;
	ts: string;
	context_left_percent: number;
	meta?: Record<string, unknown>;
};

export type AgentEventRecord = {
	type: "agent.event";
	run_id: string;
	ts: string;
	seq: number;
	event: AgentEvent;
	meta?: Record<string, unknown>;
};

export type ToolOutputRecord = {
	type: "tool.output";
	run_id: string;
	ts: string;
	tool: string;
	tool_call_id: string;
	result_raw: string;
	is_error?: boolean;
	output_ref?: ToolOutputRef;
	meta?: Record<string, unknown>;
};

export type LlmRequestRecord = {
	type: "llm.request";
	run_id: string;
	ts: string;
	seq: number;
	model?: { provider?: string; name?: string; reasoning?: string };
	input: {
		messages: BaseMessage[];
		tools?: ToolDefinition[] | null;
		tool_choice?: ToolChoice | null;
		model?: string;
	};
	meta?: Record<string, unknown>;
};

export type LlmResponseRecord = {
	type: "llm.response";
	run_id: string;
	ts: string;
	seq: number;
	output: {
		messages: BaseMessage[];
		usage?: ChatInvokeUsage | null;
		stop_reason?: string | null;
		provider_meta?: unknown;
	};
	meta?: Record<string, unknown>;
};

export type RunStatusRecord = {
	type: "run.status";
	run_id: string;
	ts: string;
	status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
	message?: string;
	meta?: Record<string, unknown>;
};

export type RunErrorRecord = {
	type: "run.error";
	run_id: string;
	ts: string;
	error: { name: string; message: string; stack?: string };
	meta?: Record<string, unknown>;
};

export type RunEndRecord = {
	type: "run.end";
	run_id: string;
	ts: string;
	outcome: "completed" | "cancelled" | "error";
	final?: string;
	meta?: Record<string, unknown>;
};

export type SessionRecord =
	| SessionHeader
	| RunStartRecord
	| RunContextRecord
	| AgentEventRecord
	| ToolOutputRecord
	| LlmRequestRecord
	| LlmResponseRecord
	| RunStatusRecord
	| RunErrorRecord
	| RunEndRecord;

export type SessionStore = {
	// append should be non-blocking and preserve call order
	append: (record: SessionRecord) => Promise<void> | void;
};

export type RunEventStoreInit = {
	runId: string;
	startedAt: string;
};

export type RunEventStoreFactory = {
	create: (init: RunEventStoreInit) => SessionStore;
};

export type SessionState = {
	schema_version: 1;
	session_id: string;
	updated_at: string;
	run_id?: string;
	invoke_seq?: number;
	messages: BaseMessage[];
	meta?: Record<string, unknown>;
};

export type SessionStateSummary = SharedSessionStateSummary;

export type SessionStateStore = {
	load: (sessionId: string) => Promise<SessionState | null>;
	save: (state: SessionState) => Promise<void>;
	list: () => Promise<SessionStateSummary[]>;
};

export type AgentSession = {
	run_id: string;
	session_id?: string;
	invoke_seq?: number;
	on_error?: (error: unknown, record: SessionRecord) => void;
	append: (record: SessionRecord) => void;
};
