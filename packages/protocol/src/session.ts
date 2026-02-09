import type { SessionStateSummary } from "@codelia/shared-types";

export type SessionListParams = {
	limit?: number;
};

export type SessionListResult = {
	sessions: SessionStateSummary[];
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
};
