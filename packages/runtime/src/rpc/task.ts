import path from "node:path";
import {
	RPC_ERROR_CODE,
	type RpcError,
	type TaskCancelParams,
	type TaskCancelResult,
	type TaskInfo,
	type TaskKind,
	type TaskListParams,
	type TaskListResult,
	type TaskOutputTruncated,
	type TaskResultParams,
	type TaskResultResult,
	type TaskSpawnParams,
	type TaskSpawnResult,
	type TaskState,
	type TaskStatusParams,
	type TaskStatusResult,
	type TaskSummary,
	type TaskWaitParams,
	type TaskWaitResult,
} from "@codelia/protocol";
import { ToolOutputCacheStoreImpl, type TaskRecord } from "@codelia/storage";
import type { RuntimeState } from "../runtime-state";
import { TaskManager, TaskManagerError } from "../tasks";
import { startShellTask } from "../tasks/shell-executor";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
	summarizeCommand,
} from "../tools/bash-utils";
import { sendError, sendResult } from "./transport";

const DEFAULT_TRUNCATED: TaskOutputTruncated = {
	stdout: false,
	stderr: false,
	combined: false,
};
const COMMAND_PREVIEW_CHARS = 400;

const truncateCommandPreview = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length <= COMMAND_PREVIEW_CHARS) return trimmed;
	return `${trimmed.slice(0, COMMAND_PREVIEW_CHARS)}...[truncated]`;
};

const toShellKeyBase = (label: string | undefined): string => {
	const source = label?.trim() ?? "";
	const slug = source
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-+|-+$/g, "");
	return slug || "shell";
};

const compactTaskId = (taskId: string): string => {
	const compact = taskId.toLowerCase().replaceAll(/[^a-z0-9]+/g, "");
	return compact || taskId.toLowerCase();
};

const getPublicTaskKey = (task: TaskRecord): string | undefined => {
	if (task.kind !== "shell") {
		return task.key;
	}
	if (task.key) {
		return task.key;
	}
	const compactId = compactTaskId(task.task_id);
	const suffix = compactId.slice(0, Math.min(8, compactId.length));
	return suffix ? `${toShellKeyBase(task.label)}-${suffix}` : undefined;
};

const isWithin = (basePath: string, candidatePath: string): boolean => {
	const relative = path.relative(basePath, candidatePath);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
};

const resolveShellCwd = (
	state: RuntimeState,
	requestedCwd?: string,
): string | null => {
	const workingDir = state.runtimeWorkingDir ?? process.cwd();
	const rootDir = state.runtimeSandboxRoot ?? workingDir;
	if (!requestedCwd) return workingDir;
	const resolved = path.resolve(workingDir, requestedCwd);
	if (!isWithin(rootDir, resolved)) {
		return null;
	}
	return resolved;
};

const parseTaskId = (value: string | undefined): string | null => {
	const taskId = value?.trim();
	return taskId ? taskId : null;
};

const toTaskRpcError = (error: unknown): RpcError => {
	if (!(error instanceof TaskManagerError)) {
		return {
			code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
			message: String(error),
		};
	}
	switch (error.code) {
		case "task_not_found":
		case "invalid_task_id":
		case "unsupported_workspace_mode":
			return {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: error.message,
			};
		case "manager_shutting_down":
			return {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: error.message,
			};
		default:
			return {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: error.message,
			};
	}
};

const sendTaskError = (id: string, error: unknown): void => {
	sendError(id, toTaskRpcError(error));
};

const toTaskSummary = (task: TaskRecord): TaskSummary => ({
	task_id: task.task_id,
	...(getPublicTaskKey(task) ? { key: getPublicTaskKey(task) } : {}),
	kind: task.kind,
	workspace_mode: task.workspace_mode,
	state: task.state,
	title: task.title,
	working_directory: task.working_directory,
	created_at: task.created_at,
	updated_at: task.updated_at,
	started_at: task.started_at,
	ended_at: task.ended_at,
	child_session_id: task.result?.child_session_id ?? task.child_session_id,
	exit_code: task.result?.exit_code ?? null,
	signal: task.result?.signal ?? null,
	duration_ms: task.result?.duration_ms ?? null,
	...(task.failure_message ? { failure_message: task.failure_message } : {}),
	...(task.cancellation_reason
		? { cancellation_reason: task.cancellation_reason }
		: {}),
	...(task.cleanup_reason ? { cleanup_reason: task.cleanup_reason } : {}),
});

const toTaskInfo = (task: TaskRecord): TaskInfo => ({
	...toTaskSummary(task),
	...(task.result?.summary ? { summary: task.result.summary } : {}),
	...(task.result?.stdout !== undefined ? { stdout: task.result.stdout } : {}),
	...(task.result?.stderr !== undefined ? { stderr: task.result.stderr } : {}),
	...(task.result?.stdout_cache_id
		? { stdout_cache_id: task.result.stdout_cache_id }
		: {}),
	...(task.result?.stderr_cache_id
		? { stderr_cache_id: task.result.stderr_cache_id }
		: {}),
	...(task.result?.truncated
		? { truncated: task.result.truncated }
		: { truncated: DEFAULT_TRUNCATED }),
	...(task.result?.worktree_path
		? { worktree_path: task.result.worktree_path }
		: {}),
	...(task.result?.artifacts ? { artifacts: task.result.artifacts } : {}),
});

const isTaskKind = (value: unknown): value is TaskKind =>
	value === "shell" || value === "subagent";

const isTaskState = (value: unknown): value is TaskState =>
	value === "queued" ||
	value === "running" ||
	value === "completed" ||
	value === "failed" ||
	value === "cancelled";

const parseShellSpawnRequest = (
	state: RuntimeState,
	params: TaskSpawnParams,
):
	| {
			command: string;
			timeoutSeconds: number;
			cwd: string;
			commandSummary: string;
			commandPreview: string;
	  }
	| { error: RpcError } => {
	const command = params.command?.trim() ?? "";
	if (!command) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "command is required for shell tasks",
			},
		};
	}
	const requestedTimeout = params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
	if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "timeout_seconds must be a positive number",
			},
		};
	}
	const timeoutSeconds = Math.max(
		1,
		Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS),
	);
	const cwd = resolveShellCwd(state, params.cwd);
	if (!cwd) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "cwd is outside sandbox root",
			},
		};
	}
	return {
		command,
		timeoutSeconds,
		cwd,
		commandSummary: summarizeCommand(command),
		commandPreview: truncateCommandPreview(command),
	};
};

export const createTaskHandlers = ({
	state,
	log,
	taskManager,
	outputCache,
}: {
	state: RuntimeState;
	log: (message: string) => void;
	taskManager?: TaskManager;
	outputCache?: ToolOutputCacheStoreImpl;
}) => {
	const tasks = taskManager ?? new TaskManager();
	const taskOutputCache = outputCache ?? new ToolOutputCacheStoreImpl();

	const handleTaskSpawn = async (
		id: string,
		params: TaskSpawnParams | undefined,
	): Promise<void> => {
		if (!params || !isTaskKind(params.kind)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "kind must be shell or subagent",
			});
			return;
		}
		if (params.kind !== "shell") {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `task kind ${params.kind} is not supported yet.`,
			});
			return;
		}
		const parsed = parseShellSpawnRequest(state, params);
		if ("error" in parsed) {
			sendError(id, parsed.error);
			return;
		}
		try {
			const background = params.background !== false;
			log(
				`task.spawn kind=shell cwd=${parsed.cwd} timeout_s=${parsed.timeoutSeconds} background=${background} command="${parsed.commandSummary}"`,
			);
			const task = await tasks.spawn(
				{
					task_id: params.task_id,
					kind: "shell",
					workspace_mode: params.workspace_mode,
					title: parsed.commandPreview,
					working_directory: parsed.cwd,
				},
				({ task }) =>
					startShellTask({
						taskId: task.task_id,
						command: parsed.command,
						cwd: parsed.cwd,
						timeoutSeconds: parsed.timeoutSeconds,
						toolName: "task.spawn",
						outputCache: taskOutputCache,
					}),
			);
			const result: TaskSpawnResult = background
				? toTaskSummary(task)
				: toTaskInfo(await tasks.wait(task.task_id));
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleTaskList = async (
		id: string,
		params: TaskListParams | undefined,
	): Promise<void> => {
		const requestedLimit = params?.limit;
		if (
			requestedLimit !== undefined &&
			(!Number.isFinite(requestedLimit) || requestedLimit <= 0)
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "limit must be a positive number",
			});
			return;
		}
		if (params?.kind !== undefined && !isTaskKind(params.kind)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "kind must be shell or subagent",
			});
			return;
		}
		if (params?.state !== undefined && !isTaskState(params.state)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "invalid task state",
			});
			return;
		}
		try {
			const limit = requestedLimit ? Math.trunc(requestedLimit) : undefined;
			const tasksList = (await tasks.list())
				.filter((task) => (params?.kind ? task.kind === params.kind : true))
				.filter((task) => (params?.state ? task.state === params.state : true))
				.slice(0, limit)
				.map(toTaskSummary);
			const result: TaskListResult = { tasks: tasksList };
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleTaskStatus = async (
		id: string,
		params: TaskStatusParams | undefined,
	): Promise<void> => {
		const taskId = parseTaskId(params?.task_id);
		if (!taskId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			});
			return;
		}
		try {
			const task = await tasks.status(taskId);
			if (!task) {
				throw new TaskManagerError(
					"task_not_found",
					`Task not found: ${taskId}`,
				);
			}
			const result: TaskStatusResult = toTaskInfo(task);
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleTaskWait = async (
		id: string,
		params: TaskWaitParams | undefined,
	): Promise<void> => {
		const taskId = parseTaskId(params?.task_id);
		if (!taskId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			});
			return;
		}
		try {
			const task = await tasks.wait(taskId);
			const result: TaskWaitResult = toTaskInfo(task);
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleTaskCancel = async (
		id: string,
		params: TaskCancelParams | undefined,
	): Promise<void> => {
		const taskId = parseTaskId(params?.task_id);
		if (!taskId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			});
			return;
		}
		try {
			const task = await tasks.cancel(taskId, {
				reason: "cancelled",
			});
			const result: TaskCancelResult = toTaskInfo(task);
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleTaskResult = async (
		id: string,
		params: TaskResultParams | undefined,
	): Promise<void> => {
		const taskId = parseTaskId(params?.task_id);
		if (!taskId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			});
			return;
		}
		try {
			const task = await tasks.status(taskId);
			if (!task) {
				throw new TaskManagerError(
					"task_not_found",
					`Task not found: ${taskId}`,
				);
			}
			const result: TaskResultResult =
				task.state === "completed" ||
				task.state === "failed" ||
				task.state === "cancelled"
					? toTaskInfo(task)
					: null;
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	return {
		handleTaskSpawn,
		handleTaskList,
		handleTaskStatus,
		handleTaskWait,
		handleTaskCancel,
		handleTaskResult,
	};
};
