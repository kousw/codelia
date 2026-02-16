import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { ToolOutputCacheStoreImpl } from "@codelia/storage";
import {
	DEFAULT_TIMEOUT_SECONDS,
	MAX_OUTPUT_BYTES,
	MAX_TIMEOUT_SECONDS,
	type ExecLikeError,
	runShellCommand,
	summarizeCommand,
} from "../tools/bash-utils";
import {
	RPC_ERROR_CODE,
	type ShellExecParams,
	type ShellExecResult,
} from "@codelia/protocol";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

const DEFAULT_EXCERPT_LINES = 80;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const COMMAND_PREVIEW_CHARS = 400;

const truncateCommandPreview = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.length <= COMMAND_PREVIEW_CHARS) return trimmed;
	return `${trimmed.slice(0, COMMAND_PREVIEW_CHARS)}...[truncated]`;
};

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
	if (lines.length <= DEFAULT_EXCERPT_LINES * 2) {
		return value;
	}
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
	const head = truncateUtf8Prefix(value, headBytes);
	const tail = truncateUtf8Suffix(value, tailBytes);
	return `${head}${marker}${tail}`;
};

const needsInlineTruncation = (value: string): boolean =>
	value.split(/\r?\n/).length > DEFAULT_EXCERPT_LINES * 2 ||
	utf8ByteLength(value) > MAX_INLINE_OUTPUT_BYTES;

const excerptText = (value: string): string =>
	excerptByBytes(excerptByLines(value), MAX_INLINE_OUTPUT_BYTES);

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

const runShellWithUserShell = async (
	command: string,
	options: {
		cwd: string;
		timeoutMs: number;
		maxOutputBytes: number;
		signal?: AbortSignal;
	},
) => {
	if (process.platform === "win32") {
		return runShellCommand(command, options);
	}
	const shellPath = process.env.SHELL?.trim() || "";
	if (!shellPath) {
		return runShellCommand(command, options);
	}
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn(shellPath, ["-lc", command], {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: options.signal,
		});
		let stdout = "";
		let stderr = "";
		let totalBytes = 0;
		let settled = false;
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		const finish = (handler: () => void): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			handler();
		};
		const consumeChunk = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
			const text = chunk.toString("utf8");
			totalBytes += Buffer.byteLength(text, "utf8");
			if (totalBytes > options.maxOutputBytes) {
				const error = Object.assign(
					new Error(
						`Command output exceeded max buffer of ${options.maxOutputBytes} bytes`,
					),
					{
						code: "MAXBUFFER",
						stdout,
						stderr,
						killed: true,
						signal: "SIGTERM",
					},
				) satisfies ExecLikeError;
				try {
					child.kill("SIGTERM");
				} catch {}
				finish(() => reject(error));
				return;
			}
			if (stream === "stdout") stdout += text;
			else stderr += text;
		};
		child.stdout?.on("data", (chunk: Buffer) => consumeChunk(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => consumeChunk(chunk, "stderr"));
		child.on("error", (error) => {
			const enriched = Object.assign(error, {
				stdout,
				stderr,
			}) satisfies ExecLikeError;
			finish(() => reject(enriched));
		});
		child.on("close", (code, signal) => {
			if (timedOut) {
				const timeoutError = Object.assign(
					new Error(
						`Command timed out after ${Math.trunc(options.timeoutMs / 1000)}s`,
					),
					{
						code: "ETIMEDOUT",
						stdout,
						stderr,
						killed: true,
						signal: signal ?? "SIGTERM",
					},
				) satisfies ExecLikeError;
				finish(() => reject(timeoutError));
				return;
			}
			if (code === 0) {
				finish(() => resolve({ stdout, stderr }));
				return;
			}
			const failure = Object.assign(
				new Error(
					`Command failed with exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`,
				),
				{ code, stdout, stderr, killed: false, signal },
			) satisfies ExecLikeError;
			finish(() => reject(failure));
		});
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			setTimeout(() => {
				try {
					if (!child.killed) child.kill("SIGKILL");
				} catch {}
			}, 2_000).unref();
		}, options.timeoutMs);
	});
};

export const createShellHandlers = ({
	state,
	log,
}: {
	state: RuntimeState;
	log: (message: string) => void;
}) => {
	const outputCache = new ToolOutputCacheStoreImpl();

	const handleShellExec = async (
		id: string,
		params: ShellExecParams | undefined,
	): Promise<void> => {
		const command = params?.command?.trim() ?? "";
		if (!command) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "command is required",
			});
			return;
		}
		const requestedTimeout = params?.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
		if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "timeout_seconds must be a positive number",
			});
			return;
		}
		const timeoutSeconds = Math.max(
			1,
			Math.min(Math.trunc(requestedTimeout), MAX_TIMEOUT_SECONDS),
		);
		const cwd = resolveShellCwd(state, params?.cwd);
		if (!cwd) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "cwd is outside sandbox root",
			});
			return;
		}
		const startedAt = Date.now();
		const commandSummary = summarizeCommand(command);
		const commandPreview = truncateCommandPreview(command);
		log(
			`shell.exec.start origin=ui_bang cwd=${cwd} timeout_s=${timeoutSeconds} command="${commandSummary}"`,
		);
		let rawStdout = "";
		let rawStderr = "";
		let exitCode: number | null = 0;
		let signal: string | null = null;
		try {
			const result = await runShellWithUserShell(command, {
				cwd,
				timeoutMs: timeoutSeconds * 1000,
				maxOutputBytes: MAX_OUTPUT_BYTES,
			});
			rawStdout = result.stdout;
			rawStderr = result.stderr;
		} catch (error) {
			const execError = error as ExecLikeError;
			rawStdout = execError.stdout ?? "";
			rawStderr = execError.stderr ?? "";
			exitCode = typeof execError.code === "number" ? execError.code : null;
			signal = execError.signal ?? null;
		}

		const stdoutTruncated = needsInlineTruncation(rawStdout);
		const stderrTruncated = needsInlineTruncation(rawStderr);
		const stdout = stdoutTruncated ? excerptText(rawStdout) : rawStdout;
		const stderr = stderrTruncated ? excerptText(rawStderr) : rawStderr;
		const combinedTruncated = stdoutTruncated || stderrTruncated;
		let stdoutCacheId: string | undefined;
		let stderrCacheId: string | undefined;
		if (stdoutTruncated && rawStdout.trim()) {
			const saved = await outputCache.save({
				tool_call_id: `shell_exec_stdout_${crypto.randomUUID()}`,
				tool_name: "shell.exec",
				content: rawStdout,
			});
			stdoutCacheId = saved.id;
		}
		if (stderrTruncated && rawStderr.trim()) {
			const saved = await outputCache.save({
				tool_call_id: `shell_exec_stderr_${crypto.randomUUID()}`,
				tool_name: "shell.exec",
				content: rawStderr,
			});
			stderrCacheId = saved.id;
		}
		const result: ShellExecResult = {
			command_preview: commandPreview,
			exit_code: exitCode,
			signal,
			stdout,
			stderr,
			truncated: {
				stdout: stdoutTruncated,
				stderr: stderrTruncated,
				combined: combinedTruncated,
			},
			duration_ms: Date.now() - startedAt,
			...(stdoutCacheId ? { stdout_cache_id: stdoutCacheId } : {}),
			...(stderrCacheId ? { stderr_cache_id: stderrCacheId } : {}),
		};
		sendResult(id, result);
		log(
			`shell.exec.done origin=ui_bang duration_ms=${result.duration_ms} exit_code=${String(result.exit_code)} signal=${result.signal ?? "-"}`,
		);
	};

	return {
		handleShellExec,
	};
};
