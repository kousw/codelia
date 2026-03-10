import type {
	TaskKind,
	TaskRecord,
	TaskResult,
	TaskState,
	TaskWorkspaceMode,
} from "@codelia/storage";

export type TerminalTaskState = Extract<
	TaskState,
	"completed" | "failed" | "cancelled"
>;

export type TaskSpawnInput = {
	task_id?: string;
	kind: TaskKind;
	workspace_mode?: TaskWorkspaceMode;
	key?: string;
	label?: string;
	title?: string;
	working_directory?: string;
	parent_session_id?: string;
	parent_run_id?: string;
	parent_tool_call_id?: string;
	child_session_id?: string;
};

export type TaskExecutionMetadata = {
	executor_pid?: number;
	executor_pgid?: number;
	child_session_id?: string;
	worktree_path?: string;
};

export type TaskExecutionOutputStream = "stdout" | "stderr";

export type TaskExecutionResult = {
	state: TerminalTaskState;
	result?: TaskResult;
	failure_message?: string;
	cancellation_reason?: string;
	cleanup_reason?: string;
};

export type TaskExecutionHandle = {
	metadata?:
		| TaskExecutionMetadata
		| Promise<TaskExecutionMetadata | null | undefined>
		| null;
	wait: Promise<TaskExecutionResult>;
	readOutput?: (stream: TaskExecutionOutputStream) => string | Promise<string>;
	cancel?: (reason?: string) => Promise<void> | void;
};

export type TaskExecutionStartContext = {
	task: TaskRecord;
};

export const isTerminalTaskState = (
	state: TaskState,
): state is TerminalTaskState =>
	state === "completed" || state === "failed" || state === "cancelled";
