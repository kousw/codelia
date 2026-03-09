import crypto from "node:crypto";
import type {
	DependencyKey,
	Tool,
	ToolOutputCacheStore,
} from "@codelia/core";
import { defineTool } from "@codelia/core";
import {
	ToolOutputCacheStoreImpl,
	type TaskRecord,
	type TaskTruncatedOutput,
} from "@codelia/storage";
import { z } from "zod";
import { debugLog } from "../logger";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import {
	TaskManager,
	TaskManagerError,
	isTerminalTaskState,
} from "../tasks";
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

const DEFAULT_TRUNCATED: TaskTruncatedOutput = {
	stdout: false,
	stderr: false,
	combined: false,
};

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

type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonObject
	| JsonValue[];

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
			.describe("Shell command to execute in the current workspace."),
		label: z
			.string()
			.max(SHELL_LABEL_MAX_CHARS)
			.optional()
			.describe(`Optional short task label used to build the returned task key. Max ${SHELL_LABEL_MAX_CHARS} chars.`),
		timeout: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				`Execution timeout in seconds. Foreground default: ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}. Background accepts larger values up to ${MAX_EXECUTION_TIMEOUT_SECONDS}; omit to keep the managed child job running until completion, cancel, or runtime exit.`,
			),
		background: z
			.boolean()
			.optional()
			.describe(
				"Detach the wait and return task info immediately. The runtime still owns the child process, so this is not persistence/daemonization. Manage it with shell_status/logs/wait/result/cancel. Default: false.",
			),
	})
	.superRefine((input, ctx) => {
		if (input.timeout === undefined) {
			return;
		}
		if (input.background ?? false) {
			if (input.timeout > MAX_EXECUTION_TIMEOUT_SECONDS) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["timeout"],
					message: `Background timeout must be ${MAX_EXECUTION_TIMEOUT_SECONDS} seconds or less. Omit timeout to run without an execution timer.`,
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

const shellStreamSchema = z.enum(["stdout", "stderr"] as const);

type ShellLogStream = z.infer<typeof shellStreamSchema>;

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
		.describe(`Return only the last N lines. Max ${SHELL_LOGS_MAX_TAIL_LINES}.`),
});

const formatTaskError = (error: unknown): Error => {
	if (error instanceof TaskManagerError) {
		return new Error(`${error.code}: ${error.message}`);
	}
	if (error instanceof Error) return error;
	return new Error(String(error));
};

const normalizeOptionalLabel = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	const label = value.trim();
	return label.length > 0 ? label : undefined;
};

const resolveShellTimeoutSeconds = (
	value: number | undefined,
	background: boolean,
): number | undefined => {
	if (background) {
		return value === undefined ? undefined : Math.max(1, Math.trunc(value));
	}
	const requestedTimeout = value ?? DEFAULT_TIMEOUT_SECONDS;
	return Math.max(1, Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS));
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
	task.key ?? `${toShellKeyBase(task.label)}-${compactTaskId(task.task_id).slice(0, 8)}`;

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
		const suffix = compactIdValue.slice(0, Math.min(length, compactIdValue.length));
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

const buildShellTaskHints = (
	taskKey: string,
	state: TaskRecord["state"],
): JsonObject => ({
	status: { key: taskKey },
	logs: { key: taskKey },
	wait: { key: taskKey },
	result: { key: taskKey },
	...(isTerminalTaskState(state) ? {} : { cancel: { key: taskKey } }),
});

const toJsonValue = (value: unknown): JsonValue => {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => toJsonValue(entry));
	}
	if (value && typeof value === "object") {
		const objectValue: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			objectValue[key] = toJsonValue(entry);
		}
		return objectValue;
	}
	return String(value);
};

const toShellTaskSummary = (task: TaskRecord): JsonObject => ({
	task_id: task.task_id,
	key: getShellTaskKey(task),
	...(task.label ? { label: task.label } : {}),
	state: task.state,
	...(task.title ? { title: task.title } : {}),
	...(task.working_directory
		? { working_directory: task.working_directory }
		: {}),
	created_at: task.created_at,
	updated_at: task.updated_at,
	...(task.started_at ? { started_at: task.started_at } : {}),
	...(task.ended_at ? { ended_at: task.ended_at } : {}),
	exit_code: task.result?.exit_code ?? null,
	duration_ms: task.result?.duration_ms ?? null,
	result_available: isTerminalTaskState(task.state) && !!task.result,
	...(task.failure_message ? { failure_message: task.failure_message } : {}),
	...(task.cancellation_reason
		? { cancellation_reason: task.cancellation_reason }
		: {}),
	...(task.cleanup_reason ? { cleanup_reason: task.cleanup_reason } : {}),
});

const toShellTaskInfo = (task: TaskRecord): JsonObject => ({
	...toShellTaskSummary(task),
	kind: task.kind,
	workspace_mode: task.workspace_mode,
	...(task.result?.child_session_id ?? task.child_session_id
		? { child_session_id: task.result?.child_session_id ?? task.child_session_id }
		: {}),
	signal: task.result?.signal ?? null,
	...(task.result?.summary ? { summary: task.result.summary } : {}),
	...(task.result?.stdout !== undefined ? { stdout: task.result.stdout } : {}),
	...(task.result?.stderr !== undefined ? { stderr: task.result.stderr } : {}),
	...(task.result?.stdout_cache_id
		? { stdout_cache_id: task.result.stdout_cache_id }
		: {}),
	...(task.result?.stderr_cache_id
		? { stderr_cache_id: task.result.stderr_cache_id }
		: {}),
	truncated: task.result?.truncated ?? DEFAULT_TRUNCATED,
	...(task.result?.worktree_path
		? { worktree_path: task.result.worktree_path }
		: {}),
	...(task.result?.artifacts
		? { artifacts: toJsonValue(task.result.artifacts) }
		: {}),
	next_actions: buildShellTaskHints(getShellTaskKey(task), task.state),
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

const getSharedDeps = (options: ShellToolDeps): {
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

const requireShellTask = async (
	tasks: TaskManager,
	taskId: string,
): Promise<TaskRecord> => {
	const task = await requireTask(tasks, taskId);
	if (task.kind !== "shell") {
		throw new TaskManagerError("task_not_found", `Shell task not found: ${taskId}`);
	}
	return task;
};

type ShellTaskKeyInput = z.infer<typeof shellTaskKeySchema>;
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
		throw new Error(`multiple shell tasks matched key \"${key}\": ${refs}`);
	}
	throw new TaskManagerError("task_not_found", `Shell task not found for key: ${key}`);
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
	const live = await options.tasks.readOutput(options.task.task_id, options.stream);
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
		const tailReadable = options.outputCacheStore as TailReadableOutputCacheStore;
		if (options.tailLines !== undefined && typeof tailReadable.readTail === "function") {
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
			? options.task.result?.stdout ?? ""
			: options.task.result?.stderr ?? "";
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

export const createShellTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	options: ShellToolDeps = {},
): Tool => {
	const shared = getSharedDeps(options);
	return defineTool({
		name: "shell",
		description:
			"Run a shell command in the sandbox. By default wait for completion; with `background=true`, detach the wait and return a runtime-managed task you can inspect, wait on, or cancel later.",
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
			const background = input.background ?? false;
			const timeoutSeconds = resolveShellTimeoutSeconds(input.timeout, background);
			const commandSummary = summarizeCommand(command);
			debugLog(
				`shell.start cwd=${sandbox.workingDir} timeout_s=${formatShellTimeoutForLog(timeoutSeconds)} background=${background} command="${commandSummary}"`,
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
				if (background) {
					return {
						background: true,
						task: toShellTaskInfo(task),
					};
				}
				const settled = await waitForForegroundRun(shared.tasks, task.task_id, ctx.signal);
				debugLog(
					`shell.done task_id=${task.task_id} state=${settled.state} duration_ms=${settled.result?.duration_ms ?? -1}`,
				);
				return {
					background: false,
					task: toShellTaskInfo(settled),
				};
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
		description: "List retained shell tasks with compact summaries, defaulting to active tasks.",
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
		description: "Get the current state and retained metadata for a shell task.",
		input: shellTaskKeySchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				return { task: toShellTaskInfo(task) };
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
		description: "Read recent stdout or stderr for a running or finished shell task.",
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
		description: "Wait for a shell task to reach a terminal state and return its retained outcome.",
		input: shellTaskKeySchema,
		execute: async (input, ctx): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				const result = await waitForManagedTask(
					shared.tasks,
					task.task_id,
					ctx.signal,
				);
				return {
					...(result.aborted ? { aborted: true } : {}),
					task: toShellTaskInfo(result.task),
				};
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
		description: "Read the retained terminal result for a shell task.",
		input: shellTaskKeySchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				return { task: toShellTaskInfo(task) };
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
		description: "Cancel a running shell task and return its retained terminal state.",
		input: shellTaskKeySchema,
		execute: async (input): Promise<JsonObject> => {
			try {
				const task = await resolveShellTask(shared.tasks, input);
				const cancelled = await shared.tasks.cancel(task.task_id, {
					reason: "cancelled",
				});
				return { task: toShellTaskInfo(cancelled) };
			} catch (error) {
				throw formatTaskError(error);
			}
		},
	});
};
