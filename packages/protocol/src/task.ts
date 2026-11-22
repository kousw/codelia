import {
	ModelFastModeSchema,
	SubagentLineageSchema,
	TaskProgressSchema,
	TaskTerminationReasonSchema,
	TaskUsageSchema,
	nullish,
	wireInt,
} from "@codelia/shared-types";
import { z } from "zod";

export const TaskStateSchema = z
	.enum(["queued", "running", "completed", "failed", "cancelled"])
	.meta({ id: "TaskState" });
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskKindSchema = z
	.enum(["shell", "subagent"])
	.meta({ id: "TaskKind" });
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskWorkspaceModeSchema = z
	.enum(["live_workspace", "worktree"])
	.meta({ id: "TaskWorkspaceMode" });
export type TaskWorkspaceMode = z.infer<typeof TaskWorkspaceModeSchema>;

export const TaskArtifactSchema = z
	.object({
		type: z.enum(["file", "patch", "json"]),
		path: z.string().optional(),
		ref: z.string().optional(),
		description: z.string().optional(),
	})
	.meta({ id: "TaskArtifact" });
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskOutputTruncatedSchema = z
	.object({
		stdout: z.boolean(),
		stderr: z.boolean(),
		combined: z.boolean(),
	})
	.meta({ id: "TaskOutputTruncated" });
export type TaskOutputTruncated = z.infer<typeof TaskOutputTruncatedSchema>;

export const TaskSummarySchema = z
	.object({
		name: z.string().optional(),
		subagent: SubagentLineageSchema.optional(),
		termination_reason: TaskTerminationReasonSchema.optional(),
		usage: TaskUsageSchema.optional(),
		task_id: z.string(),
		key: z.string().optional(),
		kind: TaskKindSchema,
		workspace_mode: TaskWorkspaceModeSchema,
		state: TaskStateSchema,
		title: z.string().optional(),
		working_directory: z.string().optional(),
		created_at: z.string(),
		updated_at: z.string(),
		started_at: z.string().optional(),
		ended_at: z.string().optional(),
		child_session_id: z.string().optional(),
		exit_code: wireInt().nullable(),
		signal: nullish(z.string()),
		duration_ms: z.number().nullable(),
		failure_message: z.string().optional(),
		cancellation_reason: z.string().optional(),
		cleanup_reason: z.string().optional(),
		/** Subagents only: latest in-memory progress (not persisted). */
		progress: TaskProgressSchema.optional(),
	})
	.meta({ id: "TaskSummary" });
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/** Opt-in (`supports_task_progress`) Runtime → UI notification for subagent tasks. */
export const TaskProgressNotifySchema = z
	.object({
		task_id: z.string(),
		name: z.string().optional(),
		state: TaskStateSchema,
		progress: TaskProgressSchema.optional(),
		usage: TaskUsageSchema.optional(),
		updated_at: z.string(),
	})
	.meta({ id: "TaskProgressNotify" });
export type TaskProgressNotify = z.infer<typeof TaskProgressNotifySchema>;

export const TaskInfoSchema = TaskSummarySchema.extend({
	summary_cache_id: z.string().optional(),
	summary: z.string().optional(),
	stdout: z.string().optional(),
	stderr: z.string().optional(),
	stdout_cache_id: z.string().optional(),
	stderr_cache_id: z.string().optional(),
	truncated: TaskOutputTruncatedSchema.optional(),
	worktree_path: z.string().optional(),
	artifacts: z.array(TaskArtifactSchema).optional(),
}).meta({ id: "TaskInfo" });
export type TaskInfo = z.infer<typeof TaskInfoSchema>;

/** Per-child model selection; overrides the configured subagent model. */
export const TaskSpawnModelSchema = z
	.object({
		provider: z.string().optional(),
		name: z.string(),
		reasoning: z.string().optional(),
		verbosity: z.string().optional(),
		fast: ModelFastModeSchema.optional(),
	})
	.meta({ id: "TaskSpawnModel" });

export const TaskSpawnParamsSchema = z
	.object({
		/** Configured model profile; mutually exclusive with model. */
		profile: z.string().optional(),
		/** Per-child selection; overrides configured subagent model and parent inheritance. */
		model: TaskSpawnModelSchema.optional(),
		/** Required for subagent admission; chosen by the spawning parent. */
		name: z.string().optional(),
		context_mode: z.enum(["fresh", "resume", "fork"]).optional(),
		workspace_access: z.enum(["read-only", "read-write"]).optional(),
		label: z.string().optional(),
		task_id: z.string().optional(),
		kind: TaskKindSchema,
		background: z.boolean().optional(),
		workspace_mode: TaskWorkspaceModeSchema.optional(),
		command: z.string().optional(),
		prompt: z.string().optional(),
		tool_allowlist: z.array(z.string()).optional(),
		max_steps: wireInt().optional(),
		timeout_seconds: z.number().optional(),
		cwd: z.string().optional(),
	})
	.meta({ id: "TaskSpawnParams" });
export type TaskSpawnParams = z.infer<typeof TaskSpawnParamsSchema>;

/** A summary, or the full task when `background: false` waited for it. */
export type TaskSpawnResult = TaskSummary | TaskInfo;

export const TaskListParamsSchema = z
	.object({
		limit: wireInt().optional(),
		kind: TaskKindSchema.optional(),
		state: TaskStateSchema.optional(),
	})
	.meta({ id: "TaskListParams" });
export type TaskListParams = z.infer<typeof TaskListParamsSchema>;

export const TaskListResultSchema = z
	.object({ tasks: z.array(TaskSummarySchema) })
	.meta({ id: "TaskListResult" });
export type TaskListResult = z.infer<typeof TaskListResultSchema>;

/** Params of the task methods that address one task. */
export const TaskIdParamsSchema = z
	.object({ task_id: z.string() })
	.meta({ id: "TaskIdParams" });
export type TaskStatusParams = z.infer<typeof TaskIdParamsSchema>;
export type TaskStatusResult = TaskInfo;
export type TaskWaitParams = TaskStatusParams;
export type TaskWaitResult = TaskInfo;
export type TaskCancelParams = TaskStatusParams;
export type TaskCancelResult = TaskInfo;
export type TaskResultParams = TaskStatusParams;

/** `null` while the task is still queued or running. */
export const TaskResultResultSchema = TaskInfoSchema.nullable().meta({
	id: "TaskResultResult",
});
export type TaskResultResult = z.infer<typeof TaskResultResultSchema>;
