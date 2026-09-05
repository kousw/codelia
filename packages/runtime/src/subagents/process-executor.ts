import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { TaskExecutionResult } from "../tasks";
import type { PreparedTaskExecution } from "../tasks/prepared";
import { subagentBootstrapSchema } from "./bootstrap";
import type {
	SubagentChannel,
	SubagentExecutorFactory,
	SubagentLaunchInput,
} from "./contracts";
import { clipUtf8, redactSubagentText } from "./output";
import { getProcessIdentity } from "./process-identity";

const moduleDir =
	typeof __dirname === "string"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));
const defaultEntry = path.join(
	moduleDir,
	existsSync(path.join(moduleDir, "child-entry.ts"))
		? "child-entry.ts"
		: "subagents/child-entry.js",
);

export const createProcessSubagentFactory = (
	options: { entry?: string; executable?: string; graceMs?: number } = {},
): SubagentExecutorFactory => ({
	isAvailable: () =>
		["darwin", "linux"].includes(process.platform) &&
		existsSync(options.entry ?? defaultEntry),
	prepare: (raw, channel) => {
		const input = subagentBootstrapSchema.parse(raw);
		return prepareProcess(input, options, channel);
	},
});

const prepareProcess = (
	input: SubagentLaunchInput,
	options: { entry?: string; executable?: string; graceMs?: number },
	channel?: SubagentChannel,
): PreparedTaskExecution => {
	const requestAbort = new AbortController();
	const requests = new Set<Promise<void>>();
	const requestIds = new Set<string>();
	let child: ChildProcess | undefined;
	let started = false;
	let closed = false;
	let runId: string | undefined;
	let outcome: TaskExecutionResult | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let killer: ReturnType<typeof setTimeout> | undefined;
	let resolveWait!: (result: TaskExecutionResult) => void;
	const wait = new Promise<TaskExecutionResult>((resolve) => {
		resolveWait = resolve;
	});
	const finish = () => {
		if (closed) return;
		closed = true;
		requestAbort.abort();
		clearTimeout(timeout);
		clearTimeout(killer);
		void Promise.allSettled([...requests]).then(() =>
			resolveWait(
				outcome ?? {
					state: "failed",
					result: { termination_reason: "execution_error" },
					failure_message: "Child exited without a terminal result",
				},
			),
		);
	};
	const kill = (signal: NodeJS.Signals) => {
		if (!child?.pid || closed) return;
		try {
			if (process.platform === "win32") child.kill(signal);
			else process.kill(-child.pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				// Retain the live handle/capacity; process close remains the only settlement proof.
				outcome = {
					...outcome,
					state: outcome?.state ?? "failed",
					cleanup_reason: "Unable to terminate child process",
				};
			}
		}
	};
	const send = (id: string, method: string, params: unknown) => {
		if (!child?.stdin?.writable || closed) return;
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
		);
	};
	const stop = (
		reason: "cancelled" | "timeout" | "startup_error" | "execution_error",
	) => {
		if (closed) return;
		requestAbort.abort();
		outcome ??= {
			state: reason === "cancelled" ? "cancelled" : "failed",
			result: { termination_reason: reason },
		};
		if (!child) {
			finish();
			return;
		}
		if (runId) send("cancel", "run.cancel", { run_id: runId });
		kill("SIGTERM");
		killer ??= setTimeout(() => kill("SIGKILL"), options.graceMs ?? 1500);
	};
	return {
		wait,
		async cancel() {
			stop("cancelled");
			await wait;
		},
		async start(control) {
			if (started || closed) return;
			started = true;
			if (input.permission.timeout_seconds !== undefined) {
				timeout = setTimeout(
					() => stop("timeout"),
					input.permission.timeout_seconds * 1000,
				);
			}
			try {
				child = spawn(
					options.executable ?? process.execPath,
					[options.entry ?? defaultEntry],
					{
						cwd: input.workspace_root,
						detached: process.platform !== "win32",
						stdio: ["pipe", "pipe", "pipe", "pipe"],
						// Provider logging can write raw credentials/payloads outside the child contract.
						env: {
							...process.env,
							CODELIA_PROVIDER_LOG: "0",
							CODELIA_DEBUG: "0",
							CODELIA_DIAGNOSTICS: "0",
						},
					},
				);
				child.once("close", finish);
				child.once("error", () => {
					outcome ??= {
						state: "failed",
						result: { termination_reason: "startup_error" },
					};
					if (!child?.pid) finish();
				});
				child.stdin?.on("error", () => stop("execution_error"));
				child.stderr?.resume(); // Never retain arbitrary bootstrap/provider stderr.
				const manifestPipe = child.stdio[3] as Writable;
				manifestPipe.on("error", () => stop("startup_error"));
				let buffer = "";
				let messageQueue = Promise.resolve();
				const dispatchMessage = async (line: string) => {
					const message = JSON.parse(line);
					if (message.method === "subagent.request") {
						if (
							!channel ||
							!runId ||
							outcome ||
							typeof message.id !== "string" ||
							!message.id.startsWith("child-") ||
							requestIds.has(message.id) ||
							requestIds.size >= 4096 ||
							requests.size >= 32
						)
							throw new Error("Invalid child request");
						requestIds.add(message.id);
						const operation = message.params?.operation;
						if (
							!["send", "receive", "list", "shell", "edit", "write"].includes(
								operation,
							)
						)
							throw new Error("Invalid child operation");
						const reply = (value: unknown) => {
							if (closed || !child?.stdin?.writable) return;
							const serialized = JSON.stringify(value);
							if (Buffer.byteLength(serialized) > 240 * 1024)
								throw new Error("Child response exceeds transport limit");
							child.stdin.write(`${serialized}\n`);
						};
						const pending = channel
							.request(operation, message.params.params, requestAbort.signal)
							.then(
								(result) => {
									reply({ jsonrpc: "2.0", id: message.id, result });
								},
								(error) => {
									reply({
										jsonrpc: "2.0",
										id: message.id,
										error: {
											code: -32000,
											message: redactSubagentText(
												error instanceof Error
													? error.message
													: "Child request failed",
											),
										},
									});
								},
							);
						requests.add(pending);
						void pending.then(
							() => requests.delete(pending),
							() => {
								requests.delete(pending);
								stop("execution_error");
							},
						);
						return;
					}

					if (message.id === "initialize" && !outcome) {
						send("start", "run.start", {
							input: { type: "text", text: input.prompt },
						});
					} else if (message.id === "start" && !outcome) {
						if (!message.result?.session_id || !message.result?.run_id) {
							stop("startup_error");
							return;
						}
						runId = message.result.run_id;
						await control.running({
							child_session_id: message.result.session_id,
						});
					} else if (
						message.method === "subagent.progress" &&
						runId &&
						!outcome
					) {
						const usage = validUsage(message.params?.usage);
						if (!usage) throw new Error("Invalid child usage");
						await control.persistExecutor({ usage });
					} else if (message.method === "subagent.result" && !outcome) {
						outcome = normalizeChildResult(
							message.params as TaskExecutionResult,
						);
						if (!outcome) {
							stop("execution_error");
							return;
						}
						// Successful result delivery is not proof of process exit.
						killer ??= setTimeout(
							() => kill("SIGKILL"),
							options.graceMs ?? 1500,
						);
					} else if (message.error)
						stop(runId ? "execution_error" : "startup_error");
				};
				child.stdout?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => {
					buffer += chunk;
					if (Buffer.byteLength(buffer) > 256 * 1024) {
						stop("execution_error");
						return;
					}
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						const line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						messageQueue = messageQueue
							.then(() => dispatchMessage(line))
							.catch(() => stop("execution_error"));
						newline = buffer.indexOf("\n");
					}
				});
				// Drain queued metadata/result processing before settling a fast-exiting child.
				child.removeListener("close", finish);
				child.once("close", () => {
					void messageQueue.finally(finish);
				});
				if (!child.pid) {
					stop("startup_error");
					return;
				}
				const identity = await getProcessIdentity(child.pid);
				if (!identity) {
					stop("startup_error");
					return;
				}
				await control.persistExecutor({
					executor_pid: child.pid,
					executor_pgid: process.platform === "win32" ? undefined : child.pid,
					executor_identity: identity,
				});
				if (closed || outcome) return;
				manifestPipe.write(`${JSON.stringify(input)}\n`);
				send("initialize", "initialize", {
					client: { name: "codelia-parent" },
				});
			} catch {
				stop("startup_error");
			}
		},
	};
};

function validUsage(
	raw: unknown,
): import("@codelia/shared-types").TaskUsage | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	if (
		typeof value.total_tokens !== "number" ||
		!Number.isFinite(value.total_tokens) ||
		value.total_tokens < 0
	)
		return undefined;
	const cost = value.total_cost_usd;
	if (
		cost !== undefined &&
		cost !== null &&
		(typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
	)
		return undefined;
	return {
		total_tokens: value.total_tokens,
		total_cost_usd: cost as number | null | undefined,
	};
}

function normalizeChildResult(
	result: TaskExecutionResult,
): TaskExecutionResult | undefined {
	const reason = result?.result?.termination_reason;
	const states = {
		normal: "completed",
		max_steps: "failed",
		timeout: "failed",
		cancelled: "cancelled",
		startup_error: "failed",
		execution_error: "failed",
	} as const;
	if (
		!reason ||
		!Object.hasOwn(states, reason) ||
		result.state !== states[reason]
	) {
		return undefined;
	}
	const usage = validUsage(result.result?.usage);
	return {
		state: result.state,
		result: {
			termination_reason: reason,
			summary: clipUtf8(
				redactSubagentText(result.result?.summary ?? ""),
				64 * 1024,
			),
			...(typeof result.result?.summary_cache_id === "string"
				? { summary_cache_id: result.result.summary_cache_id }
				: {}),
			...(typeof result.result?.child_session_id === "string"
				? { child_session_id: result.result.child_session_id }
				: {}),
			...(usage ? { usage } : {}),
		},
		...(typeof result.failure_message === "string" && result.failure_message
			? {
					failure_message: clipUtf8(
						redactSubagentText(result.failure_message),
						2048,
					),
				}
			: {}),
	};
}
