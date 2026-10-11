/** Filesystem paths/branches are observations, never caller-selected destinations. */
export type WorktreeInfo = {
	path: string;
	branch: string | null;
	head: string;
	current: boolean;
	available: boolean;
	dirty: boolean | null;
	changed_files: number | null;
	locked: boolean;
	prunable: boolean;
	managed: boolean;
	error?: string;
};

export type WorktreeCreateParams = {
	/** Stable 1–64 lowercase alphanumeric/hyphen operation ID. Reuse on retry. */
	operation_id: string;
	title: string;
	base_ref?: string;
	/** Originating UI thread/draft identity; association only, never execution authority. */
	thread_id: string;
	/** When supplied, confirmation is bound to this exact active parent run. */
	run_id?: string;
};

export type WorktreeOperation = {
	operation_id: string;
	title: string;
	base_ref: string;
	base_commit: string;
	thread_id: string;
	source_path: string;
	path: string;
	branch: string;
	phase:
		| "awaiting_confirmation"
		| "creating"
		| "ready"
		| "failed"
		| "cancelled"
		| "unknown";
	/** Durable phase before observational reconciliation; records are not rewritten/replayed. */
	recorded_phase?:
		| "awaiting_confirmation"
		| "creating"
		| "ready"
		| "failed"
		| "cancelled";
	error?: string;
};

export type WorktreeListResult = {
	project_id: string;
	checkout_id: string;
	project_root: string;
	current_path: string;
	worktrees: WorktreeInfo[];
	operations: WorktreeOperation[];
};

export type WorktreeCreateResult = {
	operation: WorktreeOperation;
	worktree?: WorktreeInfo;
};
