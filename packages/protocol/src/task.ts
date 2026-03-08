export type TaskState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type TaskKind = "shell" | "subagent";

export type TaskWorkspaceMode = "live_workspace" | "worktree";

export type TaskArtifact = {
	type: "file" | "patch" | "json";
	path?: string;
	ref?: string;
	description?: string;
};

export type TaskOutputTruncated = {
	stdout: boolean;
	stderr: boolean;
	combined: boolean;
};

export type TaskSummary = {
	task_id: string;
	key?: string;
	kind: TaskKind;
	workspace_mode: TaskWorkspaceMode;
	state: TaskState;
	title?: string;
	working_directory?: string;
	created_at: string;
	updated_at: string;
	started_at?: string;
	ended_at?: string;
	child_session_id?: string;
	exit_code: number | null;
	signal?: string | null;
	duration_ms: number | null;
	failure_message?: string;
	cancellation_reason?: string;
	cleanup_reason?: string;
};

export type TaskInfo = TaskSummary & {
	summary?: string;
	stdout?: string;
	stderr?: string;
	stdout_cache_id?: string;
	stderr_cache_id?: string;
	truncated?: TaskOutputTruncated;
	worktree_path?: string;
	artifacts?: TaskArtifact[];
};

export type TaskSpawnParams = {
	task_id?: string;
	kind: TaskKind;
	background?: boolean;
	workspace_mode?: TaskWorkspaceMode;
	command?: string;
	prompt?: string;
	tool_allowlist?: string[];
	max_steps?: number;
	timeout_seconds?: number;
	cwd?: string;
};

export type TaskSpawnResult = TaskSummary | TaskInfo;

export type TaskListParams = {
	limit?: number;
	kind?: TaskKind;
	state?: TaskState;
};

export type TaskListResult = {
	tasks: TaskSummary[];
};

export type TaskStatusParams = {
	task_id: string;
};

export type TaskStatusResult = TaskInfo;

export type TaskWaitParams = {
	task_id: string;
};

export type TaskWaitResult = TaskInfo;

export type TaskCancelParams = {
	task_id: string;
};

export type TaskCancelResult = TaskInfo;

export type TaskResultParams = {
	task_id: string;
};

export type TaskResultResult = TaskInfo | null;
