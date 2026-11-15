import type {
	LlmCallTiming,
	ModelFastMode,
	RunErrorInfo,
	SessionStateSummary as SharedSessionStateSummary,
} from "@codelia/shared-types";
import type { ProviderFailureKind } from "../llm/failures";
import type { AgentEvent } from "./events";
import type { ContentPart } from "./llm/content";
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
	model?: {
		provider?: string;
		name?: string;
		reasoning?: string;
		fast?: ModelFastMode;
		source?: "config" | "session";
	};
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
	input:
		| { type: "text"; text: string }
		| {
				type: "parts";
				parts: ContentPart[];
		  };
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
	model?: {
		provider?: string;
		name?: string;
		reasoning?: string;
		fast?: ModelFastMode;
	};
	input: {
		messages: BaseMessage[];
		tools?: ToolDefinition[] | null;
		tool_choice?: ToolChoice | null;
		model?: string;
		session_key?: string;
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
		timing?: LlmCallTiming;
		usage?: ChatInvokeUsage | null;
		stop_reason?: string | null;
		provider_meta?: unknown;
	};
	meta?: Record<string, unknown>;
};

/** Compact accounting only; never includes messages or opaque provider payloads. */
export type LlmUsageRecord = {
	type: "llm.usage";
	run_id: string;
	session_id?: string;
	ts: string;
	seq: number;
	model?: LlmRequestRecord["model"];
	output: Pick<LlmResponseRecord["output"], "usage" | "timing" | "stop_reason">;
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
	error: RunErrorInfo & { stack?: string; kind?: ProviderFailureKind };
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
	| LlmUsageRecord
	| RunStatusRecord
	| RunErrorRecord
	| RunEndRecord;

export type SessionStore = {
	filePath?: string;
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

export type ConversationMessage = {
	id: string;
	role: BaseMessage["role"];
	text: string;
	truncated: boolean;
	next_offset?: number;
};

export type ConversationSearchResult = {
	matches: ConversationMessage[];
	next_cursor?: string;
};

export type SessionStateStore = {
	load: (sessionId: string) => Promise<SessionState | null>;
	save: (state: SessionState) => Promise<void>;
	list: () => Promise<SessionStateSummary[]>;
	appendMessages?: (
		sessionId: string,
		messages: BaseMessage[],
	) => Promise<void>;
	searchMessages?: (
		sessionId: string,
		options: { query: string; cursor?: string; limit?: number },
	) => Promise<ConversationSearchResult>;
	readMessage?: (
		sessionId: string,
		options: { id: string; offset?: number; limit?: number },
	) => Promise<ConversationMessage | null>;
	updateMetadata?: (
		sessionId: string,
		patch: { pinned?: boolean; archived?: boolean },
	) => Promise<SessionStateSummary>;
};

export type AgentSession = {
	run_id: string;
	session_id?: string;
	invoke_seq?: number;
	on_error?: (error: unknown, record: SessionRecord) => void;
	append: (record: SessionRecord) => void;
	/** Await durable originals before admitting messages or discarding context. */
	recordMessages?: (messages: BaseMessage[]) => Promise<void>;
};
