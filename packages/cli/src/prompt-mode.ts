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
				event?: { type?: string; content?: string };
			};
			if (!runId || params.run_id !== runId) return;
			if (params.event?.type === "final" && typeof params.event.content === "string") {
				finalText = params.event.content;
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
