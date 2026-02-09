import { spawn } from "node:child_process";

export const DEBUG_MAX_COMMAND_CHARS = 200;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 300;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 8_000;

export type ExecLikeError = Error & {
	code?: string | number | null;
	signal?: string | null;
	killed?: boolean;
	stdout?: string;
	stderr?: string;
};

export type ShellExecutionResult = {
	stdout: string;
	stderr: string;
};

const truncate = (value: string, maxChars: number): string => {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...[truncated]`;
};

export const summarizeCommand = (command: string): string => {
	const normalized = command.trim().replace(/\s+/g, " ");
	if (normalized.length <= DEBUG_MAX_COMMAND_CHARS) {
		return normalized;
	}
	return `${normalized.slice(0, DEBUG_MAX_COMMAND_CHARS)}...[truncated]`;
};

export const formatCommandFailure = (error: ExecLikeError): string => {
	const code =
		error.code === null || error.code === undefined
			? "unknown"
			: String(error.code);
	const signal = error.signal ? ` signal=${error.signal}` : "";
	const stderr = typeof error.stderr === "string" ? error.stderr : "";
	const stdout = typeof error.stdout === "string" ? error.stdout : "";
	const details = `${stderr}${stdout}`.trim();
	if (!details) {
		return `Error: Command failed (exit code ${code}${signal}).`;
	}
	return `Error: Command failed (exit code ${code}${signal}).\n${truncate(details, MAX_ERROR_DETAIL_CHARS)}`;
};

export const runShellCommand = (
	command: string,
	options: {
		cwd: string;
		timeoutMs: number;
		maxOutputBytes: number;
		signal?: AbortSignal;
	},
): Promise<ShellExecutionResult> =>
	new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd: options.cwd,
			shell: true,
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

		const killForBufferOverflow = (): void => {
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
		};

		const consumeChunk = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
			const text = chunk.toString("utf8");
			totalBytes += Buffer.byteLength(text, "utf8");
			if (totalBytes > options.maxOutputBytes) {
				killForBufferOverflow();
				return;
			}
			if (stream === "stdout") {
				stdout += text;
				return;
			}
			stderr += text;
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			consumeChunk(chunk, "stdout");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			consumeChunk(chunk, "stderr");
		});

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
				{
					code,
					stdout,
					stderr,
					killed: false,
					signal,
				},
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
