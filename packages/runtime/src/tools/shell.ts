import crypto from "node:crypto";
import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { type TaskRecord, ToolOutputCacheStoreImpl } from "@codelia/storage";
import { z } from "zod";
import { debugLog } from "../logger";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { isTerminalTaskState, TaskManager, TaskManagerError } from "../tasks";
import { startShellTask } from "../tasks/shell-executor";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_TIMEOUT_SECONDS,
	summarizeCommand,
} from "./bash-utils";
import {
	getToolSessionContext,
	type ToolSessionContext,
} from "./session-context";

const LIVE_LOG_TAIL_BYTES = 64 * 1024;

const utf8ByteLength = (value: string): number =>
	Buffer.byteLength(value, "utf8");

const truncateUtf8Suffix = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0 || value.length === 0) return "";
	let bytes = 0;
	const chars = Array.from(value);
	const out: string[] = [];
	for (let idx = chars.length - 1; idx >= 0; idx -= 1) {
		const ch = chars[idx];
		const next = utf8ByteLength(ch);
		if (bytes + next > maxBytes) break;
		out.push(ch);
		bytes += next;
	}
	out.reverse();
	return out.join("");
};

const tailLiveOutput = (
	value: string,
	maxBytes: number,
): {
	content: string;
	truncated: boolean;
	totalBytes: number;
	omittedBytes: number;
} => {
	const totalBytes = utf8ByteLength(value);
	if (totalBytes <= maxBytes) {
		return {
			content: value,
			truncated: false,
			totalBytes,
			omittedBytes: 0,
		};
	}
	const content = truncateUtf8Suffix(value, maxBytes);
	return {
		content,
		truncated: true,
		totalBytes,
		omittedBytes: Math.max(0, totalBytes - utf8ByteLength(content)),
	};
};

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

type JsonObject = {
	[key: string]: JsonValue;
};

type ShellToolDeps = {
	taskManager?: TaskManager;
	outputCacheStore?: ToolOutputCacheStore | null;
	sessionContextKey?: DependencyKey<ToolSessionContext>;
};

const SHELL_LABEL_MAX_CHARS = 80;
const SHELL_LIST_DEFAULT_LIMIT = 20;
const SHELL_LIST_MAX_LIMIT = 100;
const SHELL_LOGS_MAX_TAIL_LINES = 500;
const SHELL_INCLUDE_STDERR_ON_SUCCESS_DEFAULT = false;

const shellStateSchema = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const);

const shellRunSchema = z
	.object({
		command: z
			.string()
			.describe(
				"Shell command to execute as a runtime-managed child process in the current workspace.",
			),
		label: z
			.string()
			.max(SHELL_LABEL_MAX_CHARS)
			.optional()
			.describe(
				`Optional short task label used to build the returned task key. Max ${SHELL_LABEL_MAX_CHARS} chars.`,
			),
		timeout: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				`Execution timeout in seconds. Foreground default: ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}. Detached-wait mode accepts larger values up to ${MAX_EXECUTION_TIMEOUT_SECONDS}; omit to keep the managed child job running until completion, cancel, or runtime exit.`,
			),
		detached_wait: z
			.boolean()
			.optional()
			.describe(
				"Skip the attached wait and return the task key immediately. The runtime still owns the child process. Use this only for finite jobs you will later inspect, wait on, or cancel. If you need a service-style process to keep running independently, start it with an explicit OS/shell-native out-of-process method such as `nohup`, `setsid`, `disown`, a service manager, or `docker compose up -d`, and verify readiness separately. Default: false.",
			),
		include_stderr_on_success: z
			.boolean()
			.optional()
			.describe(
				`Include stderr when the command succeeds. Default: ${String(SHELL_INCLUDE_STDERR_ON_SUCCESS_DEFAULT)}. Set true to include success-case stderr in terminal results.`,
			),
	})
	.superRefine((input, ctx) => {
		if (input.timeout === undefined) {
			return;
		}
		if (input.detached_wait ?? false) {
			if (input.timeout > MAX_EXECUTION_TIMEOUT_SECONDS) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["timeout"],
					message: `Detached-wait timeout must be ${MAX_EXECUTION_TIMEOUT_SECONDS} seconds or less. Omit timeout to run without an execution timer.`,
				});
			}
			return;
		}
		if (input.timeout > MAX_TIMEOUT_SECONDS) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["timeout"],
				message: `Foreground timeout must be ${MAX_TIMEOUT_SECONDS} seconds or less.`,
			});
		}
	});

const shellTaskKeySchema = z.object({
	key: z
		.string()
		.describe("Canonical shell task key returned by shell or shell_list."),
});

const shellSuccessStderrSchema = {
	include_stderr_on_success: z
		.boolean()
		.optional()
		.describe(
			`Include stderr when the command succeeds. Default: ${String(SHELL_INCLUDE_STDERR_ON_SUCCESS_DEFAULT)}. Set true to include success-case stderr in terminal results.`,
		),
} as const;

const shellWaitSchema = shellTaskKeySchema.extend({
	wait_timeout: z
		.number()
		.int()
		.positive()
		.max(MAX_TIMEOUT_SECONDS)
		.optional()
		.describe(
			`Attached wait window in seconds. Default: ${DEFAULT_TIMEOUT_SECONDS}. Max ${MAX_TIMEOUT_SECONDS}. If the task is still running when the window expires, the tool returns compact status JSON instead of hanging.`,
		),
	...shellSuccessStderrSchema,
});

const shellResultSchema = shellTaskKeySchema.extend(shellSuccessStderrSchema);

const shellStreamSchema = z.enum(["stdout", "stderr"] as const);

type ShellLogStream = z.infer<typeof shellStreamSchema>;
type ShellResultInput = z.infer<typeof shellResultSchema>;

const shellListSchema = z.object({
	limit: z
		.number()
		.int()
		.positive()
		.max(SHELL_LIST_MAX_LIMIT)
		.optional()
		.describe(
			`Max tasks to return. Default: ${SHELL_LIST_DEFAULT_LIMIT}. Max ${SHELL_LIST_MAX_LIMIT}.`,
		),
	state: shellStateSchema
		.optional()
		.describe("Exact state filter. Default: active tasks only."),
	include_terminal: z
		.boolean()
		.optional()
		.describe("Include completed/failed/cancelled tasks. Default: false."),
});

const shellLogsSchema = z.object({
	key: z
		.string()
		.describe("Canonical shell task key returned by shell or shell_list."),
	stream: shellStreamSchema
		.optional()
		.describe("Stream to read. Default: stdout."),
	tail_lines: z
		.number()
		.int()
		.positive()
		.max(SHELL_LOGS_MAX_TAIL_LINES)
		.optional()
		.describe(
			`Return only the last N lines. Max ${SHELL_LOGS_MAX_TAIL_LINES}.`,
		),
});

const formatTaskError = (error: unknown): Error => {
	if (error instanceof TaskManagerError) {
		return new Error(`${error.code}: ${error.message}`);
	}
	if (error instanceof Error) return error;
	return new Error(String(error));
};

const normalizeOptionalLabel = (
	value: string | undefined,
): string | undefined => {
	if (value === undefined) return undefined;
	const label = value.trim();
	return label.length > 0 ? label : undefined;
};

const resolveShellTimeoutSeconds = (
	value: number | undefined,
	detachedWait: boolean,
): number | undefined => {
	if (detachedWait) {
		return value === undefined ? undefined : Math.max(1, Math.trunc(value));
	}
	const requestedTimeout = value ?? DEFAULT_TIMEOUT_SECONDS;
	return Math.max(
		1,
		Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS),
	);
};

const formatShellTimeoutForLog = (value: number | undefined): string =>
	value === undefined ? "none" : String(value);

const normalizeShellTaskKey = (value: string): string => {
	const key = value.trim();
	if (!key) {
		throw new Error("key is required.");
	}
	return key;
};

const getShellTaskKey = (task: TaskRecord): string =>
	task.key ??
	`${toShellKeyBase(task.label)}-${compactTaskId(task.task_id).slice(0, 8)}`;

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
	return compact || crypto.createHash("sha256").update(taskId).digest("hex");
};

const buildShellTaskKey = async (
	tasks: TaskManager,
	taskId: string,
	label: string | undefined,
): Promise<string> => {
	const base = toShellKeyBase(label);
	const compactIdValue = compactTaskId(taskId);
	const usedKeys = new Set(
		(await tasks.list())
			.filter((task) => task.kind === "shell" && typeof task.key === "string")
			.map((task) => task.key as string),
	);
	for (const length of [8, 12, compactIdValue.length]) {
		const suffix = compactIdValue.slice(
			0,
			Math.min(length, compactIdValue.length),
		);
		if (!suffix) continue;
		const candidate = `${base}-${suffix}`;
		if (!usedKeys.has(candidate)) return candidate;
	}
	let counter = 2;
	let candidate = `${base}-${compactIdValue}`;
	while (usedKeys.has(candidate)) {
		candidate = `${base}-${compactIdValue}-${counter}`;
		counter += 1;
	}
	return candidate;
};

const trimNonEmpty = (value: string | undefined | null): string | null => {
	if (value === undefined || value === null) return null;
	const trimmed = value.trimEnd();
	return trimmed.trim().length > 0 ? trimmed : null;
};

const shellTerminalUsesCompactSuccessStreams = (task: TaskRecord): boolean => {
	const exitCode = task.result?.exit_code;
	return (
		task.state === "completed" &&
		(exitCode === null || exitCode === undefined || exitCode === 0)
	);
};

const resolveIncludeStderrOnSuccess = (value: boolean | undefined): boolean =>
	value ?? SHELL_INCLUDE_STDERR_ON_SUCCESS_DEFAULT;

const shellBasePayload = (task: TaskRecord): JsonObject => ({
	key: getShellTaskKey(task),
	state: task.state,
	...(task.title ? { command: task.title } : {}),
});

const shellStatusPayload = (
	task: TaskRecord,
	options: {
		detachedWait?: boolean;
		stillRunning?: boolean;
		aborted?: boolean;
	} = {},
): JsonObject => ({
	...shellBasePayload(task),
	...(options.detachedWait ? { detached_wait: true } : {}),
	...(options.stillRunning ? { still_running: true } : {}),
	...(options.aborted ? { aborted: true } : {}),
});

const shellTerminalPayload = (
	task: TaskRecord,
	options: { includeStderrOnSuccess?: boolean } = {},
): JsonObject => {
	const payload: JsonObject = shellBasePayload(task);
	const stdout = trimNonEmpty(task.result?.stdout);
	const stderr = trimNonEmpty(task.result?.stderr);
	const compactSuccess =
		!resolveIncludeStderrOnSuccess(options.includeStderrOnSuccess) &&
		shellTerminalUsesCompactSuccessStreams(task);
	if (task.result?.exit_code !== undefined && task.result.exit_code !== null) {
		payload.exit_code = task.result.exit_code;
	}
	if (
		task.result?.duration_ms !== undefined &&
		task.result.duration_ms !== null
	) {
		payload.duration_ms = task.result.duration_ms;
	}
	if (task.failure_message) {
		payload.failure_message = task.failure_message;
	}
	if (task.cancellation_reason) {
		payload.cancellation_reason = task.cancellation_reason;
	}
	if (stdout) {
		payload.stdout = stdout;
		if (task.result?.stdout_cache_id) {
			payload.stdout_cache_id = task.result.stdout_cache_id;
		}
	}
	if (!compactSuccess && stderr) {
		payload.stderr = stderr;
		if (task.result?.stderr_cache_id) {
			payload.stderr_cache_id = task.result.stderr_cache_id;
		}
	}
	return payload;
};

const shellCancelPayload = (task: TaskRecord): JsonObject => ({
	...shellBasePayload(task),
	...(task.cancellation_reason
		? { cancellation_reason: task.cancellation_reason }
		: {}),
	...(task.failure_message ? { failure_message: task.failure_message } : {}),
});

const toShellListEntry = (task: TaskRecord): JsonObject => ({
	key: getShellTaskKey(task),
	...(task.label ? { label: task.label } : {}),
	...(task.title ? { command: task.title } : {}),
	state: task.state,
	...(task.failure_message ? { failure_message: task.failure_message } : {}),
	...(task.cancellation_reason
		? { cancellation_reason: task.cancellation_reason }
		: {}),
});

const getSharedDeps = (
	options: ShellToolDeps,
): {
	tasks: TaskManager;
	outputCacheStore: ToolOutputCacheStore;
} => ({
	tasks: options.taskManager ?? new TaskManager(),
	outputCacheStore: options.outputCacheStore ?? new ToolOutputCacheStoreImpl(),
});

const requireTask = async (
	tasks: TaskManager,
	taskId: string,
): Promise<TaskRecord> => {
	const task = await tasks.status(taskId);
	if (!task) {
		throw new TaskManagerError("task_not_found", `Task not found: ${taskId}`);
	}
	return task;
};

type ShellTaskKeyInput = z.infer<typeof shellTaskKeySchema>;
type ShellWaitInput = z.infer<typeof shellWaitSchema>;
type TailReadableOutputCacheStore = ToolOutputCacheStore & {
	readTail?: (
		refId: string,
		options: { tail_lines: number },
	) =>
		| Promise<{ content: string; total_lines: number; omitted_lines: number }>
		| { content: string; total_lines: number; omitted_lines: number };
};

const resolveShellTask = async (
	tasks: TaskManager,
	input: ShellTaskKeyInput,
): Promise<TaskRecord> => {
	const key = normalizeShellTaskKey(input.key);
	const matches = (await tasks.list()).filter(
		(task) => task.kind === "shell" && getShellTaskKey(task) === key,
	);
	if (matches.length === 1) {
		return matches[0] as TaskRecord;
	}
	if (matches.length > 1) {
		const refs = matches.map((task) => task.task_id).join(", ");
		throw new Error(`multiple shell tasks matched key "${key}": ${refs}`);
	}
	throw new TaskManagerError(
		"task_not_found",
		`Shell task not found for key: ${key}`,
	);
};

const tailContentByLines = (
	content: string,
	tailLines: number,
): { content: string; totalLines: number; omittedLines: number } => {
	if (content.length === 0) {
		return {
			content: "",
			totalLines: 0,
			omittedLines: 0,
		};
	}
	const lines = content.split(/\r?\n/);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	const start = Math.max(0, lines.length - tailLines);
	return {
		content: lines.slice(start).join("\n"),
		totalLines: lines.length,
		omittedLines: start,
	};
};

const resolveShellLogs = async (options: {
	tasks: TaskManager;
	outputCacheStore: ToolOutputCacheStore;
	task: TaskRecord;
	stream: ShellLogStream;
	tailLines?: number;
}): Promise<JsonObject> => {
	const taskKey = getShellTaskKey(options.task);
	const live = await options.tasks.readOutput(
		options.task.task_id,
		options.stream,
	);
	if (live !== null) {
		if (options.tailLines !== undefined) {
			const tailed = tailContentByLines(live, options.tailLines);
			return {
				task_id: options.task.task_id,
				key: taskKey,
				...(options.task.label ? { label: options.task.label } : {}),
				stream: options.stream,
				live: true,
				content: tailed.content,
				tail_lines: options.tailLines,
				total_lines: tailed.totalLines,
				omitted_lines: tailed.omittedLines,
				truncated: tailed.omittedLines > 0,
			};
		}
		const recent = tailLiveOutput(live, LIVE_LOG_TAIL_BYTES);
		return {
			task_id: options.task.task_id,
			key: taskKey,
			...(options.task.label ? { label: options.task.label } : {}),
			stream: options.stream,
			live: true,
			content: recent.content,
			truncated: recent.truncated,
			...(recent.truncated
				? {
						total_bytes: recent.totalBytes,
						omitted_bytes: recent.omittedBytes,
						tail_bytes: LIVE_LOG_TAIL_BYTES,
					}
				: {}),
		};
	}
	const cacheId =
		options.stream === "stdout"
			? options.task.result?.stdout_cache_id
			: options.task.result?.stderr_cache_id;
	if (cacheId) {
		const tailReadable =
			options.outputCacheStore as TailReadableOutputCacheStore;
		if (
			options.tailLines !== undefined &&
			typeof tailReadable.readTail === "function"
		) {
			const tailed = await tailReadable.readTail(cacheId, {
				tail_lines: options.tailLines,
			});
			return {
				task_id: options.task.task_id,
				key: taskKey,
				...(options.task.label ? { label: options.task.label } : {}),
				stream: options.stream,
				live: false,
				cache_id: cacheId,
				content: tailed.content,
				tail_lines: options.tailLines,
				total_lines: tailed.total_lines,
				omitted_lines: tailed.omitted_lines,
				truncated: tailed.omitted_lines > 0,
			};
		}
		if (options.outputCacheStore.read) {
			return {
				task_id: options.task.task_id,
				key: taskKey,
				...(options.task.label ? { label: options.task.label } : {}),
				stream: options.stream,
				live: false,
				cache_id: cacheId,
				content: await options.outputCacheStore.read(cacheId),
			};
		}
	}
	const content =
		options.stream === "stdout"
			? (options.task.result?.stdout ?? "")
			: (options.task.result?.stderr ?? "");
	if (options.tailLines !== undefined) {
		const tailed = tailContentByLines(content, options.tailLines);
		return {
			task_id: options.task.task_id,
			key: taskKey,
			...(options.task.label ? { label: options.task.label } : {}),
			stream: options.stream,
			live: false,
			content: tailed.content,
			tail_lines: options.tailLines,
			total_lines: tailed.totalLines,
			omitted_lines: tailed.omittedLines,
			truncated: tailed.omittedLines > 0,
		};
	}
	return {
		task_id: options.task.task_id,
		key: taskKey,
		...(options.task.label ? { label: options.task.label } : {}),
		stream: options.stream,
		live: false,
		content,
	};
};

const waitForForegroundRun = async (
	tasks: TaskManager,
	taskId: string,
	signal?: AbortSignal,
): Promise<TaskRecord> => {
	try {
		return await tasks.wait(taskId, { signal });
	} catch (error) {
		if (signal?.aborted) {
			try {
				return await tasks.cancel(taskId, { reason: "cancelled" });
			} catch {
				return await requireTask(tasks, taskId);
			}
		}
		throw error;
	}
};

const waitForManagedTask = async (
	tasks: TaskManager,
	taskId: string,
	signal?: AbortSignal,
): Promise<{ task: TaskRecord; aborted: boolean }> => {
	try {
		const task = await tasks.wait(taskId, { signal });
		return { task, aborted: false };
	} catch (error) {
		if (signal?.aborted) {
			return {
				task: await requireTask(tasks, taskId),
				aborted: true,
			};
		}
		throw error;
	}
};

const resolveShellWaitTimeoutSeconds = (value: number | undefined): number =>
	Math.max(
		1,
		Math.min(Math.trunc(value ?? DEFAULT_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS),
	);

const waitForManagedTaskWindow = async (
	tasks: TaskManager,
	taskId: string,
	options: {
		waitTimeoutSeconds: number;
		signal?: AbortSignal;
	},
): Promise<{ task: TaskRecord; aborted: boolean; stillRunning: boolean }> => {
	let timeoutHandle: NodeJS.Timeout | undefined;
	const waitPromise = waitForManagedTask(tasks, taskId, options.signal).then(
		(result) => ({
			type: "task" as const,
			result,
		}),
	);
	const timeoutPromise = new Promise<{ type: "timeout" }>((resolve) => {
		timeoutHandle = setTimeout(
			() => resolve({ type: "timeout" }),
			options.waitTimeoutSeconds * 1000,
		);
	});
	try {
		const outcome = await Promise.race([waitPromise, timeoutPromise]);
		if (outcome.type === "task") {
			return {
				task: outcome.result.task,
				aborted: outcome.result.aborted,
				stillRunning: false,
			};
		}
		const task = await requireTask(tasks, taskId);
		if (isTerminalTaskState(task.state)) {
			return {
				task,
				aborted: false,
				stillRunning: false,
			};
		}
		return {
			task,
			aborted: false,
			stillRunning: true,
		};
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
};

export const createShellTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	options: ShellToolDeps = {},
): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell",
		description:
			"Run a shell command as a runtime-managed child process in the sandbox. Terminal results use `stdout`/`stderr` stream fields; successful results suppress `stderr` by default unless `include_stderr_on_success=true`, and `shell_logs` is available when you need explicit stream reads. By default wait for completion; with `detached_wait=true`, skip the attached wait and return compact JSON with the task key for follow-up tools.",
		input: shellRunSchema,
		execute: async (input, ctx): Promise<JsonObject> => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const sessionContext = options.sessionContextKey
				? await getToolSessionContext(ctx, options.sessionContextKey)
				: null;
			const command = input.command.trim();
			if (!command) {
				throw new Error("command is required.");
			}
			const label = normalizeOptionalLabel(input.label);
			const detachedWait = input.detached_wait ?? false;
			const timeoutSeconds = resolveShellTimeoutSeconds(
				input.timeout,
				detachedWait,
			);
			const commandSummary = summarizeCommand(command);
			debugLog(
				`shell.start cwd=${sandbox.workingDir} timeout_s=${formatShellTimeoutForLog(timeoutSeconds)} detached_wait=${detachedWait} command="${commandSummary}"`,
			);
			try {
				const taskId = crypto.randomUUID();
				const taskKey = await buildShellTaskKey(shared.tasks, taskId, label);
				const task = await shared.tasks.spawn(
					{
						task_id: taskId,
						kind: "shell",
						workspace_mode: "live_workspace",
						key: taskKey,
						label,
						title: commandSummary,
						working_directory: sandbox.workingDir,
						parent_session_id: sessionContext?.sessionId ?? undefined,
					},
					({ task }) =>
						startShellTask({
							taskId: task.task_id,
							command,
							cwd: sandbox.workingDir,
							timeoutSeconds,
							toolName: "shell",
							outputCache: shared.outputCacheStore,
						}),
				);
				if (detachedWait) {
					return shellStatusPayload(task, { detachedWait: true });
				}
				const settled = await waitForForegroundRun(
					shared.tasks,
					task.task_id,
					ctx.signal,
				);
				debugLog(
					`shell.done task_id=${task.task_id} state=${settled.state} duration_ms=${settled.result?.duration_ms ?? -1}`,
				);
				return shellTerminalPayload(settled, {
					includeStderrOnSuccess: input.include_stderr_on_success,
				});
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellListTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_list",
		description:
			"List retained shell tasks with compact summaries, defaulting to active tasks.",
		input: shellListSchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const limit = input.limit ?? SHELL_LIST_DEFAULT_LIMIT;
				const tasks = (await shared.tasks.list())
					.filter((task) => task.kind === "shell")
					.filter((task) => {
						if (input.state !== undefined) {
							return task.state === input.state;
						}
						if (input.include_terminal) {
							return true;
						}
						return task.state === "queued" || task.state === "running";
					})
					.slice(0, limit)
					.map((task) => toShellListEntry(task));
				return {
					tasks,
					returned: tasks.length,
					limit,
					state: input.state ?? null,
					include_terminal: input.include_terminal ?? false,
				};
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellStatusTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_status",
		description: "Get the current state for a shell task as compact JSON.",
		input: shellTaskKeySchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				return shellStatusPayload(task);
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellLogsTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_logs",
		description:
			"Read recent stdout or stderr for a running or finished shell task. Use this when a compact shell terminal result omitted a stream, such as `stderr` on success.",
		input: shellLogsSchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				return await resolveShellLogs({
					tasks: shared.tasks,
					outputCacheStore: shared.outputCacheStore,
					task,
					stream: input.stream ?? "stdout",
					tailLines: input.tail_lines,
				});
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellWaitTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_wait",
		description:
			"Wait for a shell task within a bounded window and return compact JSON describing either the running status or a terminal result with `stdout`/`stderr` stream fields. Successful terminal results suppress `stderr` by default unless `include_stderr_on_success=true`; use `shell_logs` for explicit stream reads.",
		input: shellWaitSchema,
		execute: async (input, ctx): Promise<JsonObject> => {
			try {
				const waitInput = input as ShellWaitInput;
				const task = await resolveShellTask(shared.tasks, waitInput);
				const result = await waitForManagedTaskWindow(
					shared.tasks,
					task.task_id,
					{
						waitTimeoutSeconds: resolveShellWaitTimeoutSeconds(
							waitInput.wait_timeout,
						),
						signal: ctx.signal,
					},
				);
				if (result.stillRunning || result.aborted) {
					return shellStatusPayload(result.task, {
						aborted: result.aborted,
						stillRunning: result.stillRunning,
					});
				}
				return shellTerminalPayload(result.task, {
					includeStderrOnSuccess: waitInput.include_stderr_on_success,
				});
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellResultTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_result",
		description:
			"Read the retained terminal result for a shell task as compact JSON with `stdout`/`stderr` stream fields. Successful terminal results suppress `stderr` by default unless `include_stderr_on_success=true`; use `shell_logs` for explicit stream reads.",
		input: shellResultSchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const resultInput = input as ShellResultInput;
				const task = await resolveShellTask(shared.tasks, resultInput);
				return isTerminalTaskState(task.state)
					? shellTerminalPayload(task, {
							includeStderrOnSuccess:
								resultInput.include_stderr_on_success,
						})
					: shellStatusPayload(task);
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};

export const createShellCancelTool = (options: ShellToolDeps = {}): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell_cancel",
		description:
			"Cancel a running shell task and return compact JSON for the cancelled state.",
		input: shellTaskKeySchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				const cancelled = await shared.tasks.cancel(task.task_id, {
					reason: "cancelled",
				});
				return shellCancelPayload(cancelled);
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};
