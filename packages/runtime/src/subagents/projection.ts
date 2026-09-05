import type { TaskInfo } from "@codelia/protocol";
import type { TaskRecord } from "@codelia/storage";
export const subagentTaskInfo = (task: TaskRecord): TaskInfo => ({
	name: task.subagent?.name,
	task_id: task.task_id,
	kind: task.kind,
	workspace_mode: task.workspace_mode,
	state: task.state,
	title: task.title,
	created_at: task.created_at,
	updated_at: task.updated_at,
	started_at: task.started_at,
	ended_at: task.ended_at,
	child_session_id: task.child_session_id ?? task.result?.child_session_id,
	exit_code: null,
	duration_ms: task.result?.duration_ms ?? null,
	subagent: task.subagent,
	termination_reason: task.result?.termination_reason,
	summary: task.result?.summary,
	summary_cache_id: task.result?.summary_cache_id,
	usage: task.result?.usage,
	failure_message: task.failure_message,
	cleanup_reason: task.cleanup_reason,
});
