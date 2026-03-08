import {
	spawn,
	type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import type { ToolOutputCacheStore } from "@codelia/core";
import type { TaskResult } from "@codelia/storage";
import {
	MAX_EXECUTION_TIMEOUT_SECONDS,
	MAX_OUTPUT_BYTES,
} from "../tools/bash-utils";
import type { TaskExecutionHandle, TaskExecutionResult } from "./types";

const DEFAULT_EXCERPT_LINES = 80;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 2_000;

const utf8ByteLength = (value: string): number =>
	Buffer.byteLength(value, "utf8");

const truncateUtf8Prefix = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0 || value.length === 0) return "";
	let bytes = 0;
	let out = "";
	for (const ch of value) {
		const next = utf8ByteLength(ch);
		if (bytes + next > maxBytes) break;
		out += ch;
		bytes += next;
	}
	return out;
};

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

const excerptByLines = (value: string): string => {
	const lines = value.split(/\r?\n/);
	if (lines.length <= DEFAULT_EXCERPT_LINES * 2) return value;
	const head = lines.slice(0, DEFAULT_EXCERPT_LINES);
	const tail = lines.slice(lines.length - DEFAULT_EXCERPT_LINES);
	const omitted = lines.length - head.length - tail.length;
	return [...head, `...[${omitted} lines omitted]...`, ...tail].join("\n");
};

const excerptByBytes = (value: string, maxBytes: number): string => {
	if (utf8ByteLength(value) <= maxBytes) return value;
	const marker = "\n...[truncated by size]...\n";
	const markerBytes = utf8ByteLength(marker);
	if (maxBytes <= markerBytes + 2) {
		return truncateUtf8Prefix(value, maxBytes);
	}
	const budget = maxBytes - markerBytes;
	const headBytes = Math.floor(budget / 2);
	const tailBytes = budget - headBytes;
	return `${truncateUtf8Prefix(value, headBytes)}${marker}${truncateUtf8Suffix(value, tailBytes)}`;
};

const needsInlineTruncation = (value: string): boolean =>
	value.split(/\r?\n/).length > DEFAULT_EXCERPT_LINES * 2 ||
	utf8ByteLength(value) > MAX_INLINE_OUTPUT_BYTES;

const excerptText = (value: string): string =>
	excerptByBytes(excerptByLines(value), MAX_INLINE_OUTPUT_BYTES);

const buildShellTaskResultBase = (options: {
	rawStdout: string;
	rawStderr: string;
	exitCode: number | null;
	signal: string | null;
	durationMs: number;
}): TaskResult => {
	const stdoutTruncated = needsInlineTruncation(options.rawStdout);
	const stderrTruncated = needsInlineTruncation(options.rawStderr);
	return {
		stdout: stdoutTruncated ? excerptText(options.rawStdout) : options.rawStdout,
		stderr: stderrTruncated ? excerptText(options.rawStderr) : options.rawStderr,
		exit_code: options.exitCode,
		signal: options.signal,
		duration_ms: options.durationMs,
		truncated: {
			stdout: stdoutTruncated,
			stderr: stderrTruncated,
			combined: stdoutTruncated || stderrTruncated,
		},
	};
};

const buildShellTaskResult = async (
	outputCache: ToolOutputCacheStore,
	options: {
		taskId: string;
		toolName: string;
		rawStdout: string;
		rawStderr: string;
		exitCode: number | null;
		signal: string | null;
		durationMs: number;
	},
): Promise<TaskResult> => {
	const base = buildShellTaskResultBase(options);
	let stdoutCacheId: string | undefined;
	let stderrCacheId: string | undefined;
	if (base.truncated?.stdout && options.rawStdout.length > 0) {
		const saved = await outputCache.save({
			tool_call_id: `${options.taskId}_stdout`,
			tool_name: options.toolName,
			content: options.rawStdout,
		});
		stdoutCacheId = saved.id;
	}
	if (base.truncated?.stderr && options.rawStderr.length > 0) {
		const saved = await outputCache.save({
			tool_call_id: `${options.taskId}_stderr`,
			tool_name: options.toolName,
			content: options.rawStderr,
		});
		stderrCacheId = saved.id;
	}
	return {
		...base,
		...(stdoutCacheId ? { stdout_cache_id: stdoutCacheId } : {}),
		...(stderrCacheId ? { stderr_cache_id: stderrCacheId } : {}),
	};
};

type ShellChildProcess = ChildProcessByStdio<null, Readable, Readable>;

type ShellTaskChildFactory = (command: string, cwd: string) => ShellChildProcess;

const spawnShellProcess: ShellTaskChildFactory = (command, cwd) => {
	const shellPath =
		process.platform === "win32" ? "" : process.env.SHELL?.trim() || "";
	if (shellPath) {
		return spawn(shellPath, ["-lc", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
	}
	return spawn(command, {
		cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
};

const terminateChild = (
	child: ShellChildProcess,
	signal: NodeJS.Signals,
): void => {
	if (typeof child.pid === "number" && process.platform !== "win32") {
		try {
			process.kill(-child.pid, signal);
		} catch {
			// best-effort group termination for detached children
		}
	}
	try {
		child.kill(signal);
	} catch {
		// best-effort direct termination
	}
};

export const startShellTask = (options: {
	taskId: string;
	command: string;
	cwd: string;
	timeoutSeconds?: number;
	toolName?: string;
	outputCache: ToolOutputCacheStore;
	spawnProcess?: ShellTaskChildFactory;
	maxOutputBytes?: number;
	forceKillDelayMs?: number;
}): TaskExecutionHandle => {
	const timeoutSeconds = options.timeoutSeconds;
	if (
		timeoutSeconds !== undefined &&
		timeoutSeconds > MAX_EXECUTION_TIMEOUT_SECONDS
	) {
		throw new Error(
			`timeoutSeconds must be ${MAX_EXECUTION_TIMEOUT_SECONDS} or less to fit Node's timer range; omit timeoutSeconds to run without an execution timer.`,
		);
	}
	const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
	const forceKillDelayMs = options.forceKillDelayMs ?? FORCE_KILL_DELAY_MS;
	const startedAt = Date.now();
	const child = (options.spawnProcess ?? spawnShellProcess)(
		options.command,
		options.cwd,
	);
	const metadata =
		typeof child.pid === "number"
			? {
				executor_pid: child.pid,
				executor_pgid: process.platform === "win32" ? undefined : child.pid,
			}
			: {};
	let stdout = "";
	let stderr = "";
	let totalBytes = 0;
	let settled = false;
	let cancelRequested = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	let forceKillHandle: NodeJS.Timeout | undefined;

	const clearForceKillHandle = (): void => {
		if (!forceKillHandle) return;
		clearTimeout(forceKillHandle);
		forceKillHandle = undefined;
	};

	const scheduleForceKill = (): void => {
		if (forceKillHandle) return;
		forceKillHandle = setTimeout(() => {
			forceKillHandle = undefined;
			terminateChild(child, "SIGKILL");
		}, forceKillDelayMs);
	};

	const wait = new Promise<TaskExecutionResult>((resolve) => {
		const settle = async (outcome: {
			state: TaskExecutionResult["state"];
			exitCode: number | null;
			signal: string | null;
			failureMessage?: string;
			cancellationReason?: string;
		}): Promise<void> => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			let result: TaskResult;
			try {
				result = await buildShellTaskResult(options.outputCache, {
					taskId: options.taskId,
					toolName: options.toolName ?? "shell.exec",
					rawStdout: stdout,
					rawStderr: stderr,
					exitCode: outcome.exitCode,
					signal: outcome.signal,
					durationMs: Date.now() - startedAt,
				});
			} catch {
				result = buildShellTaskResultBase({
					rawStdout: stdout,
					rawStderr: stderr,
					exitCode: outcome.exitCode,
					signal: outcome.signal,
					durationMs: Date.now() - startedAt,
				});
			}
			resolve({
				state: outcome.state,
				result,
				...(outcome.failureMessage
					? { failure_message: outcome.failureMessage }
					: {}),
				...(outcome.cancellationReason
					? { cancellation_reason: outcome.cancellationReason }
					: {}),
			});
		};

		const fail = (message: string, signal: string | null): void => {
			void settle({
				state: cancelRequested ? "cancelled" : "failed",
				exitCode: null,
				signal,
				failureMessage: cancelRequested ? undefined : message,
				cancellationReason: cancelRequested ? "cancelled" : undefined,
			});
		};

		const consumeChunk = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
			if (settled) return;
			const text = chunk.toString("utf8");
			totalBytes += Buffer.byteLength(text, "utf8");
			if (totalBytes > maxOutputBytes) {
				terminateChild(child, "SIGTERM");
				scheduleForceKill();
				fail(
					`Command output exceeded max buffer of ${maxOutputBytes} bytes`,
					"SIGTERM",
				);
				return;
			}
			if (stream === "stdout") stdout += text;
			else stderr += text;
		};

		child.stdout.on("data", (chunk: Buffer) => consumeChunk(chunk, "stdout"));
		child.stderr.on("data", (chunk: Buffer) => consumeChunk(chunk, "stderr"));
		child.on("error", (error) => {
			fail(error.message, null);
		});
		child.on("close", (code, signal) => {
			clearForceKillHandle();
			if (settled) return;
			if (cancelRequested) {
				void settle({
					state: "cancelled",
					exitCode: code,
					signal: signal ?? null,
					cancellationReason: "cancelled",
				});
				return;
			}
			if (code === 0) {
				void settle({
					state: "completed",
					exitCode: code,
					signal: signal ?? null,
				});
				return;
			}
			void settle({
				state: "failed",
				exitCode: code,
				signal: signal ?? null,
				failureMessage: `Command failed with exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`,
			});
		});
		if (timeoutSeconds !== undefined) {
			timeoutHandle = setTimeout(() => {
				cancelRequested = false;
				terminateChild(child, "SIGTERM");
				scheduleForceKill();
				fail(`Command timed out after ${Math.trunc(timeoutSeconds)}s`, "SIGTERM");
			}, timeoutSeconds * 1000);
		}
	});

	return {
		metadata,
		wait,
		readOutput: async (stream) => (stream === "stdout" ? stdout : stderr),
		cancel: async () => {
			if (settled) return;
			cancelRequested = true;
			terminateChild(child, "SIGTERM");
			scheduleForceKill();
		},
	};
};
