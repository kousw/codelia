import { spawn } from "node:child_process";
import type { RpcNotification, RpcRequest, RpcResponse } from "@codelia/protocol";
import { resolveRuntimeEnvForTui } from "./tui/launcher";

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
			const title = typeof event.title === "string" ? toSingleLine(event.title) : "";
			const stepNumber =
				typeof event.step_number === "number"
					? `#${String(event.step_number)} `
					: "";
			return `[step_start] ${stepNumber}${title || "unnamed step"}`;
		}
		case "step_complete": {
			const status = typeof event.status === "string" ? event.status : "unknown";
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
	!((value as Record<string, unknown>).method);

const isRpcNotification = (value: unknown): value is RpcNotification =>
	typeof value === "object" &&
	value !== null &&
	"jsonrpc" in value &&
	"method" in value &&
	!((value as Record<string, unknown>).id);

type PromptRunOptions = {
	prompt: string;
	approvalMode?: string;
};

export const runPromptMode = async (options: PromptRunOptions): Promise<number> => {
	const emitProgressToStderr = envTruthy(
		process.env.CODELIA_PROMPT_PROGRESS_STDERR,
	);
	const runtimeEnv = resolveRuntimeEnvForTui(process.env);
	const runtimeCmd = runtimeEnv.CODELIA_RUNTIME_CMD ?? process.execPath;
	const runtimeArgsValue = runtimeEnv.CODELIA_RUNTIME_ARGS ?? "packages/runtime/src/index.ts";
	const runtimeArgs = parseShellLikeArgs(runtimeArgsValue);
	if (runtimeArgs.length === 0) {
		runtimeArgs.push("packages/runtime/src/index.ts");
	}
	if (options.approvalMode) {
		runtimeArgs.push("--approval-mode", options.approvalMode);
	}

	const child = spawn(runtimeCmd, runtimeArgs, {
		env: runtimeEnv,
		stdio: ["pipe", "pipe", "pipe"],
	});

	let buffer = "";
	let runId: string | null = null;
	let finalText = "";
	let terminalStatus: "completed" | "error" | "cancelled" | null = null;
	let terminalMessage: string | undefined;

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

	const sendRequest = (request: RpcRequest): void => {
		if (startupFailure) {
			throw startupFailure;
		}
		const wrote = child.stdin.write(toLine(request));
		if (!wrote) {
			// waitResponse handles completion/failure; no-op here.
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
			if (params.event?.type === "final" && typeof params.event.content === "string") {
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
							pending.resolve(parsed);
						}
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
		sendRequest({
			jsonrpc: "2.0",
			id: "init-1",
			method: "initialize",
			params: {
				protocol_version: "0",
				client: { name: "codelia-cli-prompt", version: "0.1.0" },
				ui_capabilities: {
					supports_confirm: false,
					supports_prompt: false,
					supports_pick: false,
				},
			},
		});
		const initResponse = await waitResponse("init-1");
		if (initResponse.error) {
			throw new Error(`initialize failed: ${initResponse.error.message}`);
		}

		sendRequest({
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
				? (runResponse.result as { run_id?: unknown })
				: null;
		runId = typeof runResult?.run_id === "string" ? runResult.run_id : null;
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
		if (finalText.trim().length > 0) {
			console.log(finalText);
		}
		return 0;
	}
	if (terminalMessage) {
		console.error(terminalMessage);
	}
	return terminalStatus === "cancelled" ? 130 : 1;
};
