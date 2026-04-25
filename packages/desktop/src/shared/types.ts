import type {
	ContextInspectResult,
	McpListResult,
	ModelListResult,
	RunDiagnosticsNotify,
	RunStatus,
	UiConfirmRequestParams,
	UiPickRequestParams,
	UiPromptRequestParams,
} from "../../../protocol/src/index";
import type { AgentEvent } from "../../../shared-types/src/index";

export type DesktopUiPreferences = {
	sidebar_width?: number;
};

export type DesktopWorkspace = {
	path: string;
	name: string;
	last_opened_at: string;
	last_session_id?: string;
	invalid?: boolean;
	branch?: string | null;
	is_dirty?: boolean;
};

export type DesktopSession = {
	session_id: string;
	workspace_path: string;
	title: string;
	updated_at: string;
	message_count?: number;
	last_user_message?: string;
	archived?: boolean;
};

export type ChatMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	events: AgentEvent[];
	timestamp: number;
};

export type RuntimeHealth = {
	connected: boolean;
	initializing: boolean;
	last_error?: string;
	model?: ModelListResult;
	branch?: string | null;
	branches?: string[];
	is_dirty?: boolean;
};

export type InspectBundle = {
	context: ContextInspectResult;
	mcp: McpListResult;
	skills: {
		skills: Array<{ title: string; description?: string; filePath?: string }>;
		errors: Array<{ message: string }>;
		truncated: boolean;
	};
};

export type DesktopSnapshot = {
	workspaces: DesktopWorkspace[];
	selected_workspace_path?: string;
	sessions: DesktopSession[];
	selected_session_id?: string;
	transcript: ChatMessage[];
	runtime_health?: RuntimeHealth;
	ui_preferences?: DesktopUiPreferences;
};

export type StreamAgentEvent = {
	kind: "agent.event";
	run_id: string;
	seq: number;
	event: AgentEvent;
};

export type StreamRunStatus = {
	kind: "run.status";
	run_id: string;
	status: RunStatus;
	message?: string;
};

export type StreamRunContext = {
	kind: "run.context";
	run_id: string;
	context_left_percent: number;
};

export type StreamRunDiagnostics = {
	kind: "run.diagnostics";
	params: RunDiagnosticsNotify;
};

export type StreamUiConfirmRequest = {
	kind: "ui.request";
	request_id: string;
	method: "ui.confirm.request";
	params: UiConfirmRequestParams;
};

export type StreamUiPromptRequest = {
	kind: "ui.request";
	request_id: string;
	method: "ui.prompt.request";
	params: UiPromptRequestParams;
};

export type StreamUiPickRequest = {
	kind: "ui.request";
	request_id: string;
	method: "ui.pick.request";
	params: UiPickRequestParams;
};

export type StreamUiRequest =
	| StreamUiConfirmRequest
	| StreamUiPromptRequest
	| StreamUiPickRequest;

export type StreamDone = {
	kind: "done";
	run_id: string;
	status: RunStatus;
};

export type StreamEvent =
	| StreamAgentEvent
	| StreamRunStatus
	| StreamRunContext
	| StreamRunDiagnostics
	| StreamUiRequest
	| StreamDone;
