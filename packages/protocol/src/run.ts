import type { AgentEvent } from "@codelia/shared-types";
import type { UiContextSnapshot } from "./ui-context";

export type RunInputText = { type: "text"; text: string };

export type RunInputTextPart = {
	type: "text";
	text: string;
};

export type RunInputImagePart = {
	type: "image_url";
	image_url: {
		url: string;
		detail?: "auto" | "low" | "high";
		media_type?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	};
};

export type RunInputParts = {
	type: "parts";
	parts: Array<RunInputTextPart | RunInputImagePart>;
};

export type RunInput = RunInputText | RunInputParts;

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
