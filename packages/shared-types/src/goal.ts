export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usage_limited"
	| "budget_limited"
	| "complete";

export type GoalStopReason =
	| "user"
	| "turn_limit"
	| "run_error"
	| "checkpoint_failed"
	| "interrupted"
	| "blocker";

export type GoalRecord = {
	session_id: string;
	goal_id: string;
	revision: number;
	objective: string;
	status: GoalStatus;
	stop_reason?: GoalStopReason;
	stop_detail?: string;
	token_budget: number | null;
	tokens_used: number;
	usage_known: boolean;
	activation_id: string;
	automatic_runs: number;
	created_at: string;
	updated_at: string;
};

export type GoalSnapshot = {
	session_id: string | null;
	goal: GoalRecord | null;
	can_continue: boolean;
	accepted_run_id?: string;
	active_run_id?: string;
};

export type GoalOffer = {
	session_id: string;
	goal_id: string;
	revision: number;
	continuation_id: string;
	after_run_id?: string;
};
