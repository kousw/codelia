export type ShellOutputTruncated = {
	stdout: boolean;
	stderr: boolean;
	combined: boolean;
};

export type ShellExecParams = {
	command: string;
	timeout_seconds?: number;
	cwd?: string;
};

export type ShellExecResult = {
	command_preview: string;
	exit_code: number | null;
	signal?: string | null;
	stdout: string;
	stderr: string;
	truncated: ShellOutputTruncated;
	duration_ms: number;
	stdout_cache_id?: string;
	stderr_cache_id?: string;
};

export type ShellTaskState =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type ShellOutputStream = "stdout" | "stderr";

export type ShellTaskInfo = {
	task_id: string;
	state: ShellTaskState;
	command_preview?: string;
	cwd?: string;
	created_at: string;
	updated_at: string;
	started_at?: string;
	ended_at?: string;
	exit_code: number | null;
	signal?: string | null;
	stdout: string;
	stderr: string;
	truncated: ShellOutputTruncated;
	duration_ms: number | null;
	stdout_cache_id?: string;
	stderr_cache_id?: string;
	failure_message?: string;
	cancellation_reason?: string;
	cleanup_reason?: string;
};

export type ShellStartParams = ShellExecParams;

export type ShellStartResult = ShellTaskInfo;

export type ShellListParams = {
	limit?: number;
};

export type ShellListResult = {
	tasks: ShellTaskInfo[];
};

export type ShellStatusParams = {
	task_id: string;
};

export type ShellStatusResult = ShellTaskInfo;

export type ShellOutputParams = {
	task_id: string;
	stream: ShellOutputStream;
	offset?: number;
	limit?: number;
	line_number?: number;
	char_offset?: number;
	char_limit?: number;
};

export type ShellOutputResult = {
	task_id: string;
	stream: ShellOutputStream;
	cached: boolean;
	ref_id?: string;
	content: string;
};

export type ShellDetachParams = {
	task_id: string;
};

export type ShellDetachResult = {
	task_id: string;
	detached: true;
	state: ShellTaskState;
};

export type ShellWaitParams = {
	task_id: string;
};

export type ShellWaitResult = ShellTaskInfo | ShellDetachResult;

export type ShellCancelParams = {
	task_id: string;
};

export type ShellCancelResult = ShellTaskInfo;
