import os from "node:os";
import path from "node:path";
import { debugLog } from "./logger";
import type { ResolvedExecutionEnvironmentConfig } from "./config";
import { spawnShellProcess, terminateChild } from "./tasks/shell-executor";

const MAX_CHECK_OUTPUT_CHARS = 160;
const MAX_CAPTURE_CHARS = 4_096;
const FORCE_KILL_DELAY_MS = 200;

export type ExecutionEnvironmentHostInfo = {
	osDescription: string;
	shellExecution: string;
	bashSyntaxGuaranteed: boolean;
};

export type ExecutionEnvironmentStartupCheck = {
	command: string[];
	summary: string;
};

export type ExecutionEnvironmentCommandProbeOptions = {
	spawnProcess?: typeof spawnShellProcess;
	terminateProcess?: typeof terminateChild;
	forceKillDelayMs?: number;
};

export type ExecutionEnvironmentCommandProbe = (
	command: readonly string[],
	timeoutMs: number,
	workingDir: string,
	options?: ExecutionEnvironmentCommandProbeOptions,
) => Promise<string>;

const firstNonEmptyLine = (value: string): string | undefined => {
	for (const rawLine of value.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (line.length > 0) {
			return line;
		}
	}
	return undefined;
};

const truncate = (value: string, maxChars = MAX_CHECK_OUTPUT_CHARS): string => {
	if (value.length <= maxChars) {
		return value;
	}
	return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
};

const appendCaptured = (current: string, chunk: Buffer | string): string => {
	const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
	if (current.length >= MAX_CAPTURE_CHARS) {
		return current;
	}
	return `${current}${text}`.slice(0, MAX_CAPTURE_CHARS);
};

const formatCommandLabel = (command: readonly string[]): string =>
	JSON.stringify(command.join(" "));

const shellQuote = (value: string): string => {
	if (process.platform === "win32") {
		if (!value) return '""';
		return /^[A-Za-z0-9_./:-]+$/u.test(value)
			? value
			: `"${value.replaceAll('"', '""')}"`;
	}
	if (!value) return "''";
	return `'${value.replaceAll("'", "'\\''")}'`;
};

const buildShellCommand = (command: readonly string[]): string =>
	command.map((part) => shellQuote(part)).join(" ");

export const describeExecutionEnvironmentHost = (): ExecutionEnvironmentHostInfo => {
	const shellPath = process.platform === "win32" ? "" : process.env.SHELL?.trim() || "";
	const bashSyntaxGuaranteed =
		shellPath.length > 0 && path.basename(shellPath).toLowerCase() === "bash";
	return {
		osDescription: `${os.type()} ${os.release()} (${process.platform} ${os.arch()})`,
		shellExecution:
			shellPath.length > 0
				? `${shellPath} -lc`
				: "platform shell via spawn(shell=true)",
		bashSyntaxGuaranteed,
	};
};

export const probeExecutionEnvironmentCommand: ExecutionEnvironmentCommandProbe = (
	command,
	timeoutMs,
	workingDir,
	probeOptions = {},
) => {
	if (command.length === 0 || command[0]!.trim().length === 0) {
		return Promise.resolve("invalid command");
	}
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeoutHandle: NodeJS.Timeout | undefined;
		let forceKillHandle: NodeJS.Timeout | undefined;
		const clearForceKillHandle = (): void => {
			if (!forceKillHandle) return;
			clearTimeout(forceKillHandle);
			forceKillHandle = undefined;
		};
		const finish = (
			summary: string,
			options: { keepForceKill?: boolean } = {},
		): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			if (!options.keepForceKill) {
				clearForceKillHandle();
			}
			resolve(summary);
		};
		let child: ReturnType<typeof spawnShellProcess>;
		try {
			child = (probeOptions.spawnProcess ?? spawnShellProcess)(
				buildShellCommand(command),
				workingDir,
			);
		} catch (error) {
			finish(`error: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		timeoutHandle = setTimeout(() => {
			finish(`timeout after ${timeoutMs}ms`, { keepForceKill: true });
			(probeOptions.terminateProcess ?? terminateChild)(child, "SIGTERM");
			forceKillHandle = setTimeout(() => {
				forceKillHandle = undefined;
				(probeOptions.terminateProcess ?? terminateChild)(child, "SIGKILL");
			}, probeOptions.forceKillDelayMs ?? FORCE_KILL_DELAY_MS);
		}, timeoutMs);
		child.on("error", (error) => {
			const errorCode =
				typeof (error as NodeJS.ErrnoException).code === "string"
					? (error as NodeJS.ErrnoException).code
					: undefined;
			if (errorCode === "ENOENT") {
				finish("exit 127");
				return;
			}
			finish(
				`error: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
		child.stdout.on("data", (chunk) => {
			stdout = appendCaptured(stdout, chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr = appendCaptured(stderr, chunk);
		});
		child.on("close", (code, signal) => {
			clearForceKillHandle();
			if (settled) {
				return;
			}
			const line = firstNonEmptyLine(stdout) ?? firstNonEmptyLine(stderr);
			if (code === 0) {
				finish(line ? truncate(line) : "exit 0");
				return;
			}
			const exitSummary =
				code === null ? `signal ${signal ?? "unknown"}` : `exit ${code}`;
			finish(line ? `${truncate(line)} (${exitSummary})` : exitSummary);
		});
	});
};

export const collectExecutionEnvironmentStartupChecks = async (options: {
	config: ResolvedExecutionEnvironmentConfig;
	workingDir: string;
	probeCommand?: ExecutionEnvironmentCommandProbe;
	probeOptions?: ExecutionEnvironmentCommandProbeOptions;
}): Promise<ExecutionEnvironmentStartupCheck[]> => {
	if (!options.config.startupChecks.enabled) {
		return [];
	}
	const probeCommand = options.probeCommand ?? probeExecutionEnvironmentCommand;
	return Promise.all(
		options.config.startupChecks.commands.map(async (command) => ({
			command: [...command],
			summary: await probeCommand(
				command,
				options.config.startupChecks.timeoutMs,
				options.workingDir,
				options.probeOptions,
			),
		})),
	);
};

export const formatExecutionEnvironmentContext = (options: {
	workingDir: string;
	sandboxRoot: string;
	hostInfo: ExecutionEnvironmentHostInfo;
	startupChecks?: ExecutionEnvironmentStartupCheck[];
}): string => {
	const lines = [
		"<execution_environment>",
		`os: ${options.hostInfo.osDescription}`,
		`shell tool execution environment: ${options.hostInfo.shellExecution}`,
		`bash syntax guaranteed: ${options.hostInfo.bashSyntaxGuaranteed ? "true" : "false"}`,
		`sandbox root: ${options.sandboxRoot}`,
		`working directory: ${options.workingDir}`,
	];
	if (options.startupChecks && options.startupChecks.length > 0) {
		lines.push("", "startup checks:");
		for (const check of options.startupChecks) {
			lines.push(
				`- ${formatCommandLabel(check.command)} => ${check.summary}`,
			);
		}
	}
	lines.push("</execution_environment>");
	return lines.join("\n");
};

export const buildExecutionEnvironmentContext = async (options: {
	workingDir: string;
	sandboxRoot: string;
	config: ResolvedExecutionEnvironmentConfig;
	hostInfo?: ExecutionEnvironmentHostInfo;
	probeCommand?: ExecutionEnvironmentCommandProbe;
	probeOptions?: ExecutionEnvironmentCommandProbeOptions;
}): Promise<string> => {
	const startupChecks = await collectExecutionEnvironmentStartupChecks({
		config: options.config,
		workingDir: options.workingDir,
		probeCommand: options.probeCommand,
		probeOptions: options.probeOptions,
	});
	return formatExecutionEnvironmentContext({
		workingDir: options.workingDir,
		sandboxRoot: options.sandboxRoot,
		hostInfo: options.hostInfo ?? describeExecutionEnvironmentHost(),
		startupChecks,
	});
};

export const appendInitialExecutionEnvironment = (
	systemPrompt: string,
	executionEnvironmentContext: string | null,
): string => {
	if (!executionEnvironmentContext) {
		return systemPrompt;
	}
	return `${systemPrompt}\n\n${executionEnvironmentContext}`;
};

export const logInitialExecutionEnvironmentDebug = (
	executionEnvironmentContext: string | null,
	options: {
		alreadyLogged?: boolean;
		log?: (message: string) => void;
	} = {},
): boolean => {
	if (!executionEnvironmentContext || options.alreadyLogged) {
		return false;
	}
	(options.log ?? debugLog)(
		`startup execution environment context\n${executionEnvironmentContext}`,
	);
	return true;
};
