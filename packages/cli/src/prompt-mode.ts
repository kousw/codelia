import { spawn } from "node:child_process";
import type {
	InitializeResult,
	RpcNotification,
	RpcRequest,
	RpcResponse,
} from "@codelia/protocol";
import { writeAtifFromSessionJsonl } from "./atif";
import { resolveBundledRuntimeLaunch } from "./tui/launcher";

const parseShellLikeArgs = (value: string): string[] => {
	const out: string[] = [];
	let current = "";
	let quote: "single" | "double" | null = null;
	let escaping = false;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		if (escaping) {
			current += ch;
			escaping = false;
			continue;
		}
		if (ch === "\\" && quote !== "single") {
			escaping = true;
			continue;
		}
		if (quote === "single") {
			if (ch === "'") {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (quote === "double") {
			if (ch === '"') {
				quote = null;
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === "'") {
			quote = "single";
			continue;
		}
		if (ch === '"') {
			quote = "double";
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				out.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}
	if (current.length > 0) {
		out.push(current);
	}
	return out;
};

const toLine = (value: object): string => `${JSON.stringify(value)}\n`;

const envTruthy = (value: string | undefined): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "1" ||
		normalized === "true" ||
		normalized === "yes" ||
		normalized === "on"
	);
};

const toSingleLine = (value: string, maxChars = 240): string => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars)}...`;
};

const summarizeProgressEvent = (
	event: { type?: unknown } & Record<string, unknown>,
): string | null => {
	const type = typeof event.type === "string" ? event.type : "";
	switch (type) {
		case "text": {
			const content =
				typeof event.content === "string" ? toSingleLine(event.content) : "";
			return content ? `[text] ${content}` : "[text]";
		}
		case "reasoning": {
			const content =
				typeof event.content === "string" ? toSingleLine(event.content) : "";
			return content ? `[reasoning] ${content}` : "[reasoning]";
		}
		case "step_start": {
			const title =
				typeof event.title === "string" ? toSingleLine(event.title) : "";
			const stepNumber =
				typeof event.step_number === "number"
					? `#${String(event.step_number)} `
					: "";
			return `[step_start] ${stepNumber}${title || "unnamed step"}`;
		}
		case "step_complete": {
			const status =
				typeof event.status === "string" ? event.status : "unknown";
			const duration =
				typeof event.duration_ms === "number"
					? ` ${String(event.duration_ms)}ms`
					: "";
			return `[step_complete] ${status}${duration}`;
		}
		case "tool_call": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			return `[tool_call] ${tool}`;
		}
		case "tool_result": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			const isError = event.is_error === true ? "error" : "ok";
			return `[tool_result] ${tool} (${isError})`;
		}
		case "permission.preview": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			return `[permission.preview] ${tool}`;
		}
		case "permission.ready": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			return `[permission.ready] ${tool}`;
		}
		case "compaction_start":
			return "[compaction_start]";
		case "compaction_complete": {
			const compacted =
				typeof event.compacted === "boolean"
					? ` compacted=${String(event.compacted)}`
					: "";
			return `[compaction_complete]${compacted}`;
		}
		case "hidden_user_message":
			return "[hidden_user_message]";
		default:
			return type ? `[${type}]` : null;
	}
};

const isRpcResponse = (value: unknown): value is RpcResponse =>
	typeof value === "object" &&
	value !== null &&
	"jsonrpc" in value &&
	"id" in value &&
	!(value as Record<string, unknown>).method;

const isRpcNotification = (value: unknown): value is RpcNotification =>
	typeof value === "object" &&
	value !== null &&
	"jsonrpc" in value &&
	"method" in value &&
	!(value as Record<string, unknown>).id;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const harborUiResponse = (
	value: unknown,
	runId: string | null,
	allowShell: boolean,
): RpcResponse | undefined => {
	const request = asRecord(value);
	if (
		request?.jsonrpc !== "2.0" ||
		typeof request.id !== "string" ||
		!/^ui_[1-9]\d*$/u.test(request.id)
	)
		return undefined;
	const response = { jsonrpc: "2.0" as const, id: request.id };
	switch (request.method) {
		case "ui.confirm.request":
			return { ...response, result: { ok: false } };
		case "ui.prompt.request":
			return { ...response, result: { value: null } };
		case "ui.pick.request": {
			const params = asRecord(request.params);
			const choices =
				allowShell &&
				runId !== null &&
				params?.run_id === runId &&
				params.approval === true &&
				params.title === "Approve shell?" &&
				(params.multi === undefined || params.multi === false) &&
				Array.isArray(params.items)
					? params.items
					: [];
			const once = choices
				.map((item) => asRecord(item)?.id)
				.filter(
					(id): id is string =>
						typeof id === "string" &&
						/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\/allow_once$/u.test(id),
				);
			return { ...response, result: { ids: once.length === 1 ? once : [] } };
		}
	}
};

type PromptRunOptions = {
	prompt: string;
	sandboxMode?: string;
	harborShellApproval?: boolean;
};

type PromptModeAtifWriteOptions = {
	atifOut: string | undefined;
	sessionLogPath: string | null;
	runId: string | null;
	sandboxModeRequested?: string;
	sandboxModeReported?:
		| NonNullable<InitializeResult["sandbox_mode"]>["value"]
		| null;
};

export const writePromptModeAtif = async ({
	atifOut,
	sessionLogPath,
	runId,
	sandboxModeRequested,
	sandboxModeReported,
}: PromptModeAtifWriteOptions): Promise<"skipped" | "written"> => {
	if (!atifOut) {
		return "skipped";
	}
	if (!sessionLogPath || !runId) {
		throw new Error("CODELIA_ATIF_OUT was set but session log path is missing");
	}
	await writeAtifFromSessionJsonl({
		sessionLogPath,
		runId,
		outPath: atifOut,
		...(sandboxModeRequested
			? {
					extra: {
						sandbox_mode_requested: sandboxModeRequested,
						sandbox_mode: sandboxModeReported ?? null,
					},
				}
			: {}),
	});
	return "written";
};

export const runPromptMode = async (
	options: PromptRunOptions,
): Promise<number> => {
	const emitProgressToStderr = envTruthy(
		process.env.CODELIA_PROMPT_PROGRESS_STDERR,
	);
	const atifOut = process.env.CODELIA_ATIF_OUT?.trim();
	const harborShellRequested =
		options.harborShellApproval === true &&
		options.sandboxMode === "full-access" &&
		process.env.CODELIA_HARBOR_SHELL_APPROVAL === "1";
	const bundledRuntime = resolveBundledRuntimeLaunch(process.env);
	const runtimeCmd =
		bundledRuntime?.command ??
		process.env.CODELIA_RUNTIME_CMD ??
		process.execPath;
	const runtimeArgs = bundledRuntime
		? [...bundledRuntime.args]
		: parseShellLikeArgs(
				process.env.CODELIA_RUNTIME_ARGS ?? "packages/runtime/src/index.ts",
			);
	if (runtimeArgs.length === 0) {
		runtimeArgs.push("packages/runtime/src/index.ts");
	}
	if (options.sandboxMode) {
		runtimeArgs.push("--sandbox-mode", options.sandboxMode);
	}

	const child = spawn(runtimeCmd, runtimeArgs, {
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	let runId: string | null = null;
	let reportedSandbox: PromptModeAtifWriteOptions["sandboxModeReported"] = null;
	let harborShellAllowed = false;
	let sessionLogPath: string | null = null;
	let finalText = "";
	let terminalStatus: "completed" | "error" | "cancelled" | null = null;
	let terminalMessage: string | undefined;
	let atifWritten = false;
	let atifWriteInFlight: Promise<"skipped" | "written"> | null = null;

	const pendingResponses = new Map<
		string,
		{ resolve: (value: RpcResponse) => void; reject: (error: Error) => void }
	>();

	let startupFailure: Error | null = null;
	const failPending = (error: Error): void => {
		if (startupFailure) return;
		startupFailure = error;
		for (const pending of pendingResponses.values()) {
			pending.reject(error);
		}
		pendingResponses.clear();
	};

	const waitResponse = (id: string): Promise<RpcResponse> => {
		if (startupFailure) {
			return Promise.reject(startupFailure);
		}
		return new Promise((resolve, reject) => {
			pendingResponses.set(id, { resolve, reject });
		});
	};

	const sendMessage = (request: RpcRequest | RpcResponse): void => {
		if (startupFailure) {
			throw startupFailure;
		}
		const wrote = child.stdin.write(toLine(request));
		if (!wrote) {
			// waitResponse handles completion/failure; no-op here.
		}
	};

	const writeAtifOnce = async (): Promise<"skipped" | "written"> => {
		if (atifWritten) {
			return "written";
		}
		atifWriteInFlight ??= writePromptModeAtif({
			atifOut,
			sessionLogPath,
			runId,
			sandboxModeRequested: options.sandboxMode,
			sandboxModeReported: reportedSandbox,
		});
		const result = await atifWriteInFlight;
		if (result === "written") {
			atifWritten = true;
		}
		return result;
	};

	const signalNumbers = {
		SIGHUP: 1,
		SIGINT: 2,
		SIGTERM: 15,
	} satisfies Partial<Record<NodeJS.Signals, number>>;
	const handledSignals = Object.keys(signalNumbers) as Array<
		keyof typeof signalNumbers
	>;
	const handleTerminationSignal = (signal: NodeJS.Signals): void => {
		void (async () => {
			try {
				await writeAtifOnce();
			} catch (error) {
				console.error(
					`Failed to write partial ATIF trajectory on ${signal}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			} finally {
				if (!child.killed) {
					child.kill(signal);
				}
				process.exit(
					128 + (signalNumbers[signal as keyof typeof signalNumbers] ?? 1),
				);
			}
		})();
	};
	for (const signal of handledSignals) {
		process.once(signal, handleTerminationSignal);
	}
	const cleanupSignalHandlers = (): void => {
		for (const signal of handledSignals) {
			process.removeListener(signal, handleTerminationSignal);
		}
	};

	const maybeTrackRunLifecycle = (value: unknown): void => {
		if (!isRpcNotification(value)) return;
		if (value.method === "run.status") {
			const params = (value.params ?? {}) as {
				run_id?: string;
				status?: string;
				message?: string;
			};
			if (!runId || params.run_id !== runId) return;
			if (
				params.status === "completed" ||
				params.status === "error" ||
				params.status === "cancelled"
			) {
				terminalStatus = params.status;
				terminalMessage = params.message;
			}
			return;
		}
		if (value.method === "run.end") {
			const params = (value.params ?? {}) as {
				run_id?: string;
				final?: string;
			};
			if (!runId || params.run_id !== runId) return;
			if (typeof params.final === "string") {
				finalText = params.final;
			}
			return;
		}
		if (value.method === "agent.event") {
			const params = (value.params ?? {}) as {
				run_id?: string;
				event?: { type?: string; content?: string } & Record<string, unknown>;
			};
			if (!runId || params.run_id !== runId) return;
			if (
				params.event?.type === "final" &&
				typeof params.event.content === "string"
			) {
				finalText = params.event.content;
			}
			const event = params.event;
			if (emitProgressToStderr && event && event.type !== "final") {
				const summary = summarizeProgressEvent(event);
				if (summary) {
					process.stderr.write(`${summary}\n`);
				}
			}
		}
	};

	child.on("error", (error) => {
		failPending(
			error instanceof Error
				? error
				: new Error(`runtime process error: ${String(error)}`),
		);
	});
	child.on("close", (code, signal) => {
		if (terminalStatus) return;
		failPending(
			new Error(
				`runtime exited before completion (code=${String(code)} signal=${String(signal)})`,
			),
		);
	});
	child.stdin.on("error", (error) => {
		failPending(
			error instanceof Error
				? error
				: new Error(`runtime stdin error: ${String(error)}`),
		);
	});

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length > 0) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRpcResponse(parsed)) {
						const pending = pendingResponses.get(String(parsed.id));
						if (pending) {
							pendingResponses.delete(String(parsed.id));
							if (parsed.id === "run-1") {
								const result = asRecord(parsed.result);
								runId =
									typeof result?.run_id === "string" ? result.run_id : null;
							}
							pending.resolve(parsed);
						}
					}
					if (harborShellRequested) {
						const response = harborUiResponse(
							parsed,
							terminalStatus ? null : runId,
							harborShellAllowed,
						);
						if (response) sendMessage(response);
					}
					maybeTrackRunLifecycle(parsed);
				} catch {
					// ignore invalid line
				}
			}
			index = buffer.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		process.stderr.write(chunk);
	});

	try {
		sendMessage({
			jsonrpc: "2.0",
			id: "init-1",
			method: "initialize",
			params: {
				protocol_version: "0",
				client: { name: "codelia-cli-prompt", version: "0.1.0" },
				ui_capabilities: {
					supports_confirm: false,
					supports_prompt: false,
					supports_pick: harborShellRequested,
					...(harborShellRequested
						? { supports_structured_approval: true }
						: {}),
				},
			},
		});
		const initResponse = await waitResponse("init-1");
		if (initResponse.error) {
			throw new Error(`initialize failed: ${initResponse.error.message}`);
		}

		const init = initResponse.result as InitializeResult | undefined;
		const mode = init?.sandbox_mode?.value;
		reportedSandbox =
			mode === "readonly" ||
			mode === "workspace-write" ||
			mode === "full-access"
				? mode
				: null;
		harborShellAllowed =
			harborShellRequested &&
			init?.server_capabilities?.supports_structured_approval === true &&
			reportedSandbox === "full-access";

		sendMessage({
			jsonrpc: "2.0",
			id: "run-1",
			method: "run.start",
			params: {
				input: { type: "text", text: options.prompt },
			},
		});
		const runResponse = await waitResponse("run-1");
		if (runResponse.error) {
			throw new Error(`run.start failed: ${runResponse.error.message}`);
		}
		const runResult =
			typeof runResponse.result === "object" && runResponse.result !== null
				? (runResponse.result as {
						run_id?: unknown;
						session_log_path?: unknown;
					})
				: null;
		sessionLogPath =
			typeof runResult?.session_log_path === "string"
				? runResult.session_log_path
				: null;
		if (!runId) {
			throw new Error("run.start did not return run_id");
		}

		await new Promise<void>((resolve, reject) => {
			const timeout = setInterval(() => {
				if (terminalStatus) {
					clearInterval(timeout);
					resolve();
					return;
				}
				if (startupFailure) {
					clearInterval(timeout);
					reject(startupFailure);
				}
			}, 50);
		});
	} catch (error) {
		cleanupSignalHandlers();
		console.error(
			`Prompt run failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	} finally {
		if (!child.killed) {
			child.kill();
		}
	}

	if (terminalStatus === "completed") {
		try {
			await writeAtifOnce();
		} catch (error) {
			cleanupSignalHandlers();
			console.error(
				`Failed to write ATIF trajectory: ${error instanceof Error ? error.message : String(error)}`,
			);
			return 1;
		}
		cleanupSignalHandlers();
		if (finalText.trim().length > 0) {
			console.log(finalText);
		}
		return 0;
	}
	try {
		await writeAtifOnce();
	} catch (error) {
		console.error(
			`Failed to write partial ATIF trajectory: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	cleanupSignalHandlers();
	if (terminalMessage) {
		console.error(terminalMessage);
	}
	return terminalStatus === "cancelled" ? 130 : 1;
};
