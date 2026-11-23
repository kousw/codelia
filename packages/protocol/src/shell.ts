import { keyed, nullish, wireCount, wireInt } from "@codelia/shared-types";
import { z } from "zod";

export const ShellOutputTruncatedSchema = z
	.object({
		stdout: z.boolean(),
		stderr: z.boolean(),
		combined: z.boolean(),
	})
	.meta({ id: "ShellOutputTruncated" });
export type ShellOutputTruncated = z.infer<typeof ShellOutputTruncatedSchema>;

export const ShellExecParamsSchema = z
	.object({
		command: z.string(),
		timeout_seconds: z.number().optional(),
		cwd: z.string().optional(),
	})
	.meta({ id: "ShellExecParams" });
export type ShellExecParams = z.infer<typeof ShellExecParamsSchema>;

export const ShellExecResultSchema = z
	.object({
		command_preview: z.string(),
		exit_code: wireInt().nullable(),
		signal: nullish(z.string()),
		stdout: z.string(),
		stderr: z.string(),
		truncated: ShellOutputTruncatedSchema,
		duration_ms: z.number(),
		stdout_cache_id: z.string().optional(),
		stderr_cache_id: z.string().optional(),
	})
	.meta({ id: "ShellExecResult" });
export type ShellExecResult = z.infer<typeof ShellExecResultSchema>;

export const ShellTaskStateSchema = z
	.enum(["queued", "running", "completed", "failed", "cancelled"])
	.meta({ id: "ShellTaskState" });
export type ShellTaskState = z.infer<typeof ShellTaskStateSchema>;

export const ShellOutputStreamSchema = z
	.enum(["stdout", "stderr"])
	.meta({ id: "ShellOutputStream" });
export type ShellOutputStream = z.infer<typeof ShellOutputStreamSchema>;

export const ShellTaskInfoSchema = z
	.object({
		task_id: z.string(),
		state: ShellTaskStateSchema,
		/** `shell.wait` returned before the task finished. */
		still_running: z.boolean().optional(),
		command_preview: z.string().optional(),
		cwd: z.string().optional(),
		created_at: z.string(),
		updated_at: z.string(),
		started_at: z.string().optional(),
		ended_at: z.string().optional(),
		exit_code: wireInt().nullable(),
		signal: nullish(z.string()),
		stdout: z.string(),
		stderr: z.string(),
		truncated: ShellOutputTruncatedSchema,
		duration_ms: z.number().nullable(),
		stdout_cache_id: z.string().optional(),
		stderr_cache_id: z.string().optional(),
		failure_message: z.string().optional(),
		cancellation_reason: z.string().optional(),
		cleanup_reason: z.string().optional(),
	})
	.meta({ id: "ShellTaskInfo" });
export type ShellTaskInfo = z.infer<typeof ShellTaskInfoSchema>;

export const ShellStartParamsSchema = ShellExecParamsSchema;
export type ShellStartParams = ShellExecParams;
export type ShellStartResult = ShellTaskInfo;

export const ShellListParamsSchema = z
	.object({ limit: wireCount().optional() })
	.meta({ id: "ShellListParams" });
export type ShellListParams = z.infer<typeof ShellListParamsSchema>;

export const ShellListResultSchema = z
	.object({ tasks: z.array(ShellTaskInfoSchema) })
	.meta({ id: "ShellListResult" });
export type ShellListResult = z.infer<typeof ShellListResultSchema>;

/** Params of the shell methods that address one task. */
export const ShellTaskIdParamsSchema = z
	.object({ task_id: z.string() })
	.meta({ id: "ShellTaskIdParams" });
export type ShellStatusParams = z.infer<typeof ShellTaskIdParamsSchema>;
export type ShellStatusResult = ShellTaskInfo;

export const ShellOutputParamsSchema = z
	.object({
		task_id: z.string(),
		stream: ShellOutputStreamSchema,
		offset: wireCount().optional(),
		limit: wireCount().optional(),
		line_number: wireCount().optional(),
		char_offset: wireCount().optional(),
		char_limit: wireCount().optional(),
	})
	.meta({ id: "ShellOutputParams" });
export type ShellOutputParams = z.infer<typeof ShellOutputParamsSchema>;

export const ShellOutputResultSchema = z
	.object({
		task_id: z.string(),
		stream: ShellOutputStreamSchema,
		cached: z.boolean(),
		ref_id: z.string().optional(),
		content: z.string(),
	})
	.meta({ id: "ShellOutputResult" });
export type ShellOutputResult = z.infer<typeof ShellOutputResultSchema>;

export type ShellDetachParams = ShellStatusParams;

export const ShellDetachResultSchema = z
	.object({
		task_id: z.string(),
		detached: z.literal(true),
		state: ShellTaskStateSchema,
	})
	.meta({ id: "ShellDetachResult" });
export type ShellDetachResult = z.infer<typeof ShellDetachResultSchema>;

export const ShellWaitParamsSchema = z
	.object({
		task_id: z.string(),
		wait_timeout_seconds: z.number().optional(),
	})
	.meta({ id: "ShellWaitParams" });
export type ShellWaitParams = z.infer<typeof ShellWaitParamsSchema>;

/** The task, or `{ detached: true }` when `shell.detach` released the wait. */
export const ShellWaitResultSchema = keyed(
	[ShellTaskInfoSchema, ShellDetachResultSchema],
	{ id: "ShellWaitResult" },
);
export type ShellWaitResult = z.infer<typeof ShellWaitResultSchema>;

export type ShellCancelParams = ShellStatusParams;
export type ShellCancelResult = ShellTaskInfo;
