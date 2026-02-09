import type { AgentEvent } from "@codelia/shared-types";
import type { UiContextSnapshot } from "./ui-context";

export type RunInput = { type: "text"; text: string };

export type RunStartParams = {
	input: RunInput;
	session_id?: string;
	force_compaction?: boolean;
	ui_context?: UiContextSnapshot;
	meta?: Record<string, unknown>;
};

export type RunStartResult = {
	run_id: string;
};

export type AgentEventNotify = {
	run_id: string;
	seq: number;
	event: AgentEvent;
	meta?: Record<string, unknown>;
};

export type RunCancelParams = {
	run_id: string;
	reason?: string;
};

export type RunStatus =
	| "running"
	| "awaiting_ui"
	| "completed"
	| "error"
	| "cancelled";

export type RunStatusNotify = {
	run_id: string;
	status: RunStatus;
	message?: string;
};

export type RunContextNotify = {
	run_id: string;
	context_left_percent: number;
};
