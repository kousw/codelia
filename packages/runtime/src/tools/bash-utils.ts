export const DEBUG_MAX_COMMAND_CHARS = 200;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 300;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
export const MAX_EXECUTION_TIMEOUT_SECONDS = Math.floor(
	MAX_TIMER_DELAY_MS / 1000,
);
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
