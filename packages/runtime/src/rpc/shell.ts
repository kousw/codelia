import path from "node:path";
import {
	RPC_ERROR_CODE,
	type RpcError,
	type ShellCancelParams,
	type ShellDetachParams,
	type ShellDetachResult,
	type ShellExecParams,
	type ShellExecResult,
	type ShellListParams,
	type ShellListResult,
	type ShellOutputParams,
	type ShellOutputResult,
	type ShellOutputStream,
	type ShellOutputTruncated,
	type ShellStartParams,
	type ShellStatusParams,
	type ShellTaskInfo,
	type ShellWaitParams,
} from "@codelia/protocol";
import {
	ToolOutputCacheStoreImpl,
	type TaskRecord,
	type TaskResult,
} from "@codelia/storage";
import type { RuntimeState } from "../runtime-state";
import {
	isTerminalTaskState,
	TaskManager,
	TaskManagerError,
} from "../tasks";
import { startShellTask } from "../tasks/shell-executor";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
	summarizeCommand,
} from "../tools/bash-utils";
import { sendError, sendResult } from "./transport";

const COMMAND_PREVIEW_CHARS = 400;
const DEFAULT_TRUNCATED: ShellOutputTruncated = {
	stdout: false,
	stderr: false,
	combined: false,
};

const truncateCommandPreview = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length <= COMMAND_PREVIEW_CHARS) return trimmed;
	return `${trimmed.slice(0, COMMAND_PREVIEW_CHARS)}...[truncated]`;
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

const formatLineNumber = (value: number): string => String(value).padStart(6, "0");

const readInlineOutput = (
	content: string,
	options: { offset?: number; limit?: number },
): string => {
	const lines = content.split(/\r?\n/);
	const offset = options.offset ?? 0;
	const limit = options.limit ?? lines.length;
	if (offset >= lines.length) {
		return "Offset exceeds output length.";
	}
	return lines
		.slice(offset, offset + limit)
		.map((line, index) => `${formatLineNumber(offset + index + 1)}  ${line}`)
		.join("\n");
};

const readInlineOutputLine = (
	content: string,
	options: { line_number: number; char_offset?: number; char_limit?: number },
): string => {
	const lines = content.split(/\r?\n/);
	const lineIndex = options.line_number - 1;
	if (lineIndex < 0 || lineIndex >= lines.length) {
		return `Line number out of range: ${options.line_number} (total ${lines.length})`;
	}
	const line = lines[lineIndex] ?? "";
	const charOffset = Math.max(0, options.char_offset ?? 0);
	const charLimit = Math.max(1, Math.trunc(options.char_limit ?? 10_000));
	if (charOffset > line.length) {
		return `char_offset out of range: ${charOffset} (line length ${line.length})`;
	}
	return line.slice(charOffset, charOffset + charLimit);
};

const parseShellOutputRequest = (
	params: ShellOutputParams | undefined,
):
	| {
			taskId: string;
			stream: ShellOutputStream;
			offset?: number;
			limit?: number;
			lineNumber?: number;
			charOffset?: number;
			charLimit?: number;
	  }
	| { error: RpcError } => {
	const taskId = parseTaskId(params?.task_id);
	if (!taskId) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			},
		};
	}
	if (params?.stream !== "stdout" && params?.stream !== "stderr") {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "stream must be stdout or stderr",
			},
		};
	}
	if (
		params.line_number !== undefined &&
		(params.offset !== undefined || params.limit !== undefined)
	) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "line_number cannot be combined with offset or limit",
			},
		};
	}
	if (
		params.line_number === undefined &&
		(params.char_offset !== undefined || params.char_limit !== undefined)
	) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "char_offset/char_limit require line_number",
			},
		};
	}
	if (params.offset !== undefined && (!Number.isFinite(params.offset) || params.offset < 0)) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "offset must be a non-negative number",
			},
		};
	}
	if (params.limit !== undefined && (!Number.isFinite(params.limit) || params.limit <= 0)) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "limit must be a positive number",
			},
		};
	}
	if (
		params.line_number !== undefined &&
		(!Number.isFinite(params.line_number) || params.line_number <= 0)
	) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "line_number must be a positive number",
			},
		};
	}
	if (
		params.char_offset !== undefined &&
		(!Number.isFinite(params.char_offset) || params.char_offset < 0)
	) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "char_offset must be a non-negative number",
			},
		};
	}
	if (
		params.char_limit !== undefined &&
		(!Number.isFinite(params.char_limit) || params.char_limit <= 0)
	) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "char_limit must be a positive number",
			},
		};
	}
	return {
		taskId,
		stream: params.stream,
		offset: params.offset !== undefined ? Math.trunc(params.offset) : undefined,
		limit: params.limit !== undefined ? Math.trunc(params.limit) : undefined,
		lineNumber:
			params.line_number !== undefined ? Math.trunc(params.line_number) : undefined,
		charOffset:
			params.char_offset !== undefined ? Math.trunc(params.char_offset) : undefined,
		charLimit:
			params.char_limit !== undefined ? Math.trunc(params.char_limit) : undefined,
	};
};

const toShellExecResult = (
	commandPreview: string,
	result: TaskResult | undefined,
): ShellExecResult => ({
	command_preview: commandPreview,
	exit_code: result?.exit_code ?? null,
	signal: result?.signal ?? null,
	stdout: result?.stdout ?? "",
	stderr: result?.stderr ?? "",
	truncated: result?.truncated ?? DEFAULT_TRUNCATED,
	duration_ms: result?.duration_ms ?? 0,
	...(result?.stdout_cache_id ? { stdout_cache_id: result.stdout_cache_id } : {}),
	...(result?.stderr_cache_id ? { stderr_cache_id: result.stderr_cache_id } : {}),
});

const toShellTaskInfo = (task: TaskRecord): ShellTaskInfo => ({
	task_id: task.task_id,
	state: task.state,
	command_preview: task.title,
	cwd: task.working_directory,
	created_at: task.created_at,
	updated_at: task.updated_at,
	started_at: task.started_at,
	ended_at: task.ended_at,
	exit_code: task.result?.exit_code ?? null,
	signal: task.result?.signal ?? null,
	stdout: task.result?.stdout ?? "",
	stderr: task.result?.stderr ?? "",
	truncated: task.result?.truncated ?? DEFAULT_TRUNCATED,
	duration_ms: task.result?.duration_ms ?? null,
	...(task.result?.stdout_cache_id
		? { stdout_cache_id: task.result.stdout_cache_id }
		: {}),
	...(task.result?.stderr_cache_id
		? { stderr_cache_id: task.result.stderr_cache_id }
		: {}),
	...(task.failure_message ? { failure_message: task.failure_message } : {}),
	...(task.cancellation_reason
		? { cancellation_reason: task.cancellation_reason }
		: {}),
	...(task.cleanup_reason ? { cleanup_reason: task.cleanup_reason } : {}),
});

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
	const rpcError = toTaskRpcError(error);
	sendError(id, rpcError);
};

type ActiveShellWait = {
	detach: (task: TaskRecord) => void;
};

const requireShellTask = async (
	taskManager: TaskManager,
	taskId: string,
): Promise<TaskRecord> => {
	const task = await taskManager.status(taskId);
	if (!task || task.kind !== "shell") {
		throw new TaskManagerError("task_not_found", `Shell task not found: ${taskId}`);
	}
	return task;
};

const resolveShellTimeoutSeconds = (
	requestedTimeout: number | undefined,
	background: boolean,
): number | undefined | { error: RpcError } => {
	if (requestedTimeout !== undefined) {
		if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "timeout_seconds must be a positive number",
				},
			};
		}
		if (!background) {
			return Math.max(
				1,
				Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS),
			);
		}
		if (requestedTimeout > MAX_EXECUTION_TIMEOUT_SECONDS) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `background timeout_seconds must be ${MAX_EXECUTION_TIMEOUT_SECONDS} or less; omit timeout_seconds to run without an execution timer`,
				},
			};
		}
		return Math.max(1, Math.trunc(requestedTimeout));
	}
	return background ? undefined : DEFAULT_TIMEOUT_SECONDS;
};

const resolveShellWaitTimeoutSeconds = (
	requestedTimeout: number | undefined,
): number | { error: RpcError } => {
	if (requestedTimeout !== undefined) {
		if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "wait_timeout_seconds must be a positive number",
				},
			};
		}
		if (requestedTimeout > MAX_TIMEOUT_SECONDS) {
			return {
				error: {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `wait_timeout_seconds must be ${MAX_TIMEOUT_SECONDS} seconds or less`,
				},
			};
		}
		return Math.max(1, Math.trunc(requestedTimeout));
	}
	return DEFAULT_TIMEOUT_SECONDS;
};

const formatShellTimeoutForLog = (value: number | undefined): string =>
	value === undefined ? "none" : String(value);

const parseShellStartRequest = (
	state: RuntimeState,
	params: ShellExecParams | ShellStartParams | undefined,
	options: { background: boolean },
):
	| {
			command: string;
			timeoutSeconds?: number;
			cwd: string;
			commandSummary: string;
			commandPreview: string;
	  }
	| {
			error: RpcError;
	  } => {
	const command = params?.command?.trim() ?? "";
	if (!command) {
		return {
			error: {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "command is required",
			},
		};
	}
	const timeoutSeconds = resolveShellTimeoutSeconds(
		params?.timeout_seconds,
		options.background,
	);
	if (typeof timeoutSeconds === "object") {
		return timeoutSeconds;
	}
	const cwd = resolveShellCwd(state, params?.cwd);
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

export const createShellHandlers = ({
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
	const shellTaskManager = taskManager ?? new TaskManager();
	const shellOutputCache = outputCache ?? new ToolOutputCacheStoreImpl();
	const activeShellWaits = new Map<string, Set<ActiveShellWait>>();

	const registerActiveShellWait = (
		taskId: string,
		wait: ActiveShellWait,
	): (() => void) => {
		const waits = activeShellWaits.get(taskId) ?? new Set<ActiveShellWait>();
		waits.add(wait);
		activeShellWaits.set(taskId, waits);
		return () => {
			const current = activeShellWaits.get(taskId);
			if (!current) return;
			current.delete(wait);
			if (current.size === 0) {
				activeShellWaits.delete(taskId);
			}
		};
	};

	const spawnShell = async (
		params: ShellExecParams | ShellStartParams | undefined,
		toolName: "shell.exec" | "shell.start",
	): Promise<{ task: TaskRecord; commandPreview: string }> => {
		const background = toolName === "shell.start";
		const parsed = parseShellStartRequest(state, params, { background });
		if ("error" in parsed) {
			throw parsed.error;
		}
		log(
			`${toolName}.start origin=ui_bang cwd=${parsed.cwd} timeout_s=${formatShellTimeoutForLog(parsed.timeoutSeconds)} command="${parsed.commandSummary}"`,
		);
		const task = await shellTaskManager.spawn(
			{
				kind: "shell",
				workspace_mode: "live_workspace",
				title: parsed.commandPreview,
				working_directory: parsed.cwd,
			},
			({ task }) =>
				startShellTask({
					taskId: task.task_id,
					command: parsed.command,
					cwd: parsed.cwd,
					timeoutSeconds: parsed.timeoutSeconds,
					toolName,
					outputCache: shellOutputCache,
				}),
		);
		return { task, commandPreview: parsed.commandPreview };
	};

	const handleShellExec = async (
		id: string,
		params: ShellExecParams | undefined,
	): Promise<void> => {
		try {
			const { task, commandPreview } = await spawnShell(params, "shell.exec");
			const finished = await shellTaskManager.wait(task.task_id);
			const result = toShellExecResult(commandPreview, finished.result);
			sendResult(id, result);
			log(
				`shell.exec.done origin=ui_bang duration_ms=${result.duration_ms} exit_code=${String(result.exit_code)} signal=${result.signal ?? "-"}`,
			);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				"message" in error
			) {
				sendError(id, error as RpcError);
				return;
			}
			sendTaskError(id, error);
		}
	};

	const handleShellStart = async (
		id: string,
		params: ShellStartParams | undefined,
	): Promise<void> => {
		try {
			const { task } = await spawnShell(params, "shell.start");
			sendResult(id, toShellTaskInfo(task));
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				"message" in error
			) {
				sendError(id, error as RpcError);
				return;
			}
			sendTaskError(id, error);
		}
	};

	const handleShellList = async (
		id: string,
		params: ShellListParams | undefined,
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
		try {
			const limit = requestedLimit ? Math.trunc(requestedLimit) : undefined;
			const tasks = (await shellTaskManager.list())
				.filter((task) => task.kind === "shell")
				.slice(0, limit)
				.map(toShellTaskInfo);
			const result: ShellListResult = { tasks };
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleShellStatus = async (
		id: string,
		params: ShellStatusParams | undefined,
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
			const task = await requireShellTask(shellTaskManager, taskId);
			sendResult(id, toShellTaskInfo(task));
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleShellOutput = async (
		id: string,
		params: ShellOutputParams | undefined,
	): Promise<void> => {
		const parsed = parseShellOutputRequest(params);
		if ("error" in parsed) {
			sendError(id, parsed.error);
			return;
		}
		try {
			const task = await requireShellTask(shellTaskManager, parsed.taskId);
			const cacheId =
				parsed.stream === "stdout"
					? task.result?.stdout_cache_id
					: task.result?.stderr_cache_id;
			const retainedContent =
				parsed.stream === "stdout"
					? task.result?.stdout ?? ""
					: task.result?.stderr ?? "";
			const liveContent = await shellTaskManager.readOutput(
				parsed.taskId,
				parsed.stream,
			);
			if (!cacheId && liveContent === null && !isTerminalTaskState(task.state)) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_BUSY,
					message: `shell output is not retained yet for running task: ${parsed.taskId}`,
				});
				return;
			}
			const inlineContent = liveContent ?? retainedContent;
			const content = cacheId
				? parsed.lineNumber !== undefined
					? await shellOutputCache.readLine(cacheId, {
							line_number: parsed.lineNumber,
							char_offset: parsed.charOffset,
							char_limit: parsed.charLimit,
						})
					: await shellOutputCache.read(cacheId, {
							offset: parsed.offset,
							limit: parsed.limit,
						})
				: parsed.lineNumber !== undefined
					? readInlineOutputLine(inlineContent, {
							line_number: parsed.lineNumber,
							char_offset: parsed.charOffset,
							char_limit: parsed.charLimit,
						})
					: readInlineOutput(inlineContent, {
							offset: parsed.offset,
							limit: parsed.limit,
						});
			const result: ShellOutputResult = {
				task_id: parsed.taskId,
				stream: parsed.stream,
				cached: Boolean(cacheId),
				content,
				...(cacheId ? { ref_id: cacheId } : {}),
			};
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleShellWait = async (
		id: string,
		params: ShellWaitParams | undefined,
	): Promise<void> => {
		const taskId = parseTaskId(params?.task_id);
		if (!taskId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "task_id is required",
			});
			return;
		}
		const waitTimeoutSeconds = resolveShellWaitTimeoutSeconds(
			params?.wait_timeout_seconds,
		);
		if (typeof waitTimeoutSeconds === "object") {
			sendError(id, waitTimeoutSeconds.error);
			return;
		}
		try {
			const existing = await requireShellTask(shellTaskManager, taskId);
			if (isTerminalTaskState(existing.state)) {
				sendResult(id, toShellTaskInfo(existing));
				return;
			}
			const controller = new AbortController();
			let timeoutHandle: NodeJS.Timeout | undefined;
			let resolveDetached!: (result: ShellDetachResult) => void;
			const detachPromise = new Promise<{ type: "detached"; result: ShellDetachResult }>(
				(resolve) => {
					resolveDetached = (result) => resolve({ type: "detached", result });
				},
			);
			const timeoutPromise = new Promise<{ type: "still_running" }>((resolve) => {
				timeoutHandle = setTimeout(() => {
					controller.abort();
					resolve({ type: "still_running" });
				}, waitTimeoutSeconds * 1000);
			});
			const unregister = registerActiveShellWait(taskId, {
				detach: (task) => {
					resolveDetached({
						task_id: task.task_id,
						detached: true,
						state: task.state,
					});
					controller.abort();
				},
			});
			try {
				const waitPromise = shellTaskManager
					.wait(taskId, { signal: controller.signal })
					.then((task) => ({ type: "task" as const, task }))
					.catch((error) => {
						if (controller.signal.aborted) {
							return { type: "aborted" as const };
						}
						throw error;
					});
				const outcome = await Promise.race([
					waitPromise,
					detachPromise,
					timeoutPromise,
				]);
				if (outcome.type === "detached") {
					sendResult(id, outcome.result);
					return;
				}
				if (outcome.type === "still_running") {
					const task = await requireShellTask(shellTaskManager, taskId);
					sendResult(id, {
						...toShellTaskInfo(task),
						...(isTerminalTaskState(task.state)
							? {}
							: { still_running: true }),
					});
					return;
				}
				if (outcome.type === "aborted") {
					return;
				}
				sendResult(id, toShellTaskInfo(outcome.task));
			} finally {
				if (timeoutHandle) {
					clearTimeout(timeoutHandle);
				}
				unregister();
			}
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleShellDetach = async (
		id: string,
		params: ShellDetachParams | undefined,
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
			const task = await requireShellTask(shellTaskManager, taskId);
			const waits = activeShellWaits.get(taskId);
			if (!waits || waits.size === 0) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `no active shell.wait to detach for task: ${taskId}`,
				});
				return;
			}
			for (const wait of [...waits]) {
				wait.detach(task);
			}
			const result: ShellDetachResult = {
				task_id: task.task_id,
				detached: true,
				state: task.state,
			};
			sendResult(id, result);
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	const handleShellCancel = async (
		id: string,
		params: ShellCancelParams | undefined,
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
			await requireShellTask(shellTaskManager, taskId);
			const task = await shellTaskManager.cancel(taskId, {
				reason: "cancelled",
			});
			sendResult(id, toShellTaskInfo(task));
		} catch (error) {
			sendTaskError(id, error);
		}
	};

	return {
		handleShellExec,
		handleShellStart,
		handleShellList,
		handleShellStatus,
		handleShellOutput,
		handleShellWait,
		handleShellDetach,
		handleShellCancel,
	};
};
