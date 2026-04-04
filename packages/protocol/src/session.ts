import type { SessionStateSummary } from "@codelia/shared-types";

export type SessionListParams = {
	limit?: number;
	scope?: "current_workspace" | "all";
	workspace_root?: string;
};

export type SessionListResult = {
	sessions: SessionStateSummary[];
	current_workspace_root?: string;
};

export type SessionHistoryParams = {
	session_id: string;
	max_runs?: number;
	max_events?: number;
};

export type SessionHistoryResult = {
	runs: number;
	events_sent: number;
	truncated?: boolean;
	resume_diff?: string;
};
