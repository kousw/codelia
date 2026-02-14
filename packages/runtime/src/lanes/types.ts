export type LaneState =
	| "creating"
	| "running"
	| "finished"
	| "error"
	| "closed";

export type LaneBackend = "tmux" | "zellij";

export type LaneRecord = {
	lane_id: string;
	task_id: string;
	state: LaneState;
	mux_backend: LaneBackend;
	mux_target: string;
	worktree_path: string;
	branch_name: string;
	session_id: string;
	created_at: string;
	updated_at: string;
	last_activity_at: string;
	last_error?: string;
};

export type LaneCreateInput = {
	task_id: string;
	base_ref?: string;
	worktree_path?: string;
	mux_backend?: LaneBackend;
	seed_context?: string;
};

export type LaneCloseInput = {
	lane_id: string;
	remove_worktree?: boolean;
	force?: boolean;
};

export type LaneGcInput = {
	idle_ttl_minutes: number;
	remove_worktree?: boolean;
	force?: boolean;
};
