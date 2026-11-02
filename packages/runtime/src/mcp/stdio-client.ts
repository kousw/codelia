import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import type { McpClient, McpRequestOptions } from "./client";
import {
	buildCancelParams,
	CANCELLED_METHOD,
	createAbortError,
	describeError,
	isRecord,
	JSON_RPC_VERSION,
	type JsonRpcResponse,
	normalizeRpcError,
	toLine,
} from "./jsonrpc";

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
	cleanupAbort?: () => void;
};

export type StdioClientOptions = {
	serverId: string;
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	log: (message: string) => void;
};

export class StdioMcpClient implements McpClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private closed = false;
	private closePromise: Promise<void> | null = null;
	private sequence = 0;

	constructor(private readonly options: StdioClientOptions) {
		const env = {
			...process.env,
			...(options.env ?? {}),
		};
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.bindStreams();
	}

	private bindStreams(): void {
		const stdoutReader = createInterface({ input: this.child.stdout });
		stdoutReader.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				this.options.log(
					`mcp[${this.options.serverId}] stdout(non-json): ${trimmed}`,
				);
				return;
			}
			this.handleRpcResponse(parsed);
		});

		const stderrReader = createInterface({ input: this.child.stderr });
		stderrReader.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			this.options.log(`mcp[${this.options.serverId}] stderr: ${trimmed}`);
		});

		this.child.once("error", (error) => {
			this.failAllPending(
				new Error(
					`mcp stdio process error (${this.options.serverId}): ${describeError(error)}`,
				),
			);
		});
		this.child.once("exit", (code, signal) => {
			if (this.closed) return;
			this.closed = true;
			this.failAllPending(
				new Error(
					`mcp stdio exited (${this.options.serverId}): code=${String(code)} signal=${String(signal)}`,
				),
			);
			void this.close().catch(() => {
				this.options.log(
					`mcp[${this.options.serverId}] process cleanup failed`,
				);
			});
		});
	}

	private handleRpcResponse(value: unknown): void {
		if (!isRecord(value)) return;
		const message = value as JsonRpcResponse;
		if (message.id === undefined || message.id === null) return;
		const requestId = String(message.id);
		const pending = this.pending.get(requestId);
		if (!pending) return;
		clearTimeout(pending.timeout);
		if (pending.cleanupAbort) {
			pending.cleanupAbort();
		}
		this.pending.delete(requestId);
		if (message.error) {
			pending.reject(normalizeRpcError("request", message.error));
			return;
		}
		pending.resolve(message.result);
	}

	private failAllPending(error: Error): void {
		for (const [requestId, pending] of this.pending) {
			clearTimeout(pending.timeout);
			if (pending.cleanupAbort) pending.cleanupAbort();
			pending.reject(error);
			this.pending.delete(requestId);
		}
	}

	private nextRequestId(): string {
		this.sequence += 1;
		return `${this.options.serverId}-${this.sequence}`;
	}

	private writeJsonRpc(payload: Record<string, unknown>): Promise<void> {
		if (this.closed) {
			return Promise.reject(
				new Error(`mcp stdio is closed: ${this.options.serverId}`),
			);
		}
		return new Promise((resolve, reject) => {
			this.child.stdin.write(toLine(payload), (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	async request(
		method: string,
		params: unknown,
		options: McpRequestOptions,
	): Promise<unknown> {
		const requestId = this.nextRequestId();
		const payload: Record<string, unknown> = {
			jsonrpc: JSON_RPC_VERSION,
			id: requestId,
			method,
			params,
		};
		return new Promise<unknown>((resolve, reject) => {
			let cleanupAbort: (() => void) | undefined;
			const timeout = setTimeout(() => {
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				if (pending.cleanupAbort) pending.cleanupAbort();
				reject(
					new Error(
						`MCP request timed out (${this.options.serverId}): ${method}`,
					),
				);
			}, options.timeoutMs);

			if (options.signal) {
				if (options.signal.aborted) {
					clearTimeout(timeout);
					reject(createAbortError("MCP request aborted"));
					void this.notify(
						CANCELLED_METHOD,
						buildCancelParams(requestId, "aborted"),
					);
					return;
				}
				const onAbort = () => {
					this.pending.delete(requestId);
					clearTimeout(timeout);
					if (cleanupAbort) cleanupAbort();
					reject(createAbortError("MCP request aborted"));
					void this.notify(
						CANCELLED_METHOD,
						buildCancelParams(requestId, "aborted"),
					);
				};
				cleanupAbort = () => {
					options.signal?.removeEventListener("abort", onAbort);
				};
				options.signal.addEventListener("abort", onAbort, { once: true });
			}

			this.pending.set(requestId, {
				resolve,
				reject,
				timeout,
				cleanupAbort,
			});

			void this.writeJsonRpc(payload).catch((error) => {
				const pending = this.pending.get(requestId);
				if (!pending) return;
				this.pending.delete(requestId);
				clearTimeout(pending.timeout);
				if (pending.cleanupAbort) pending.cleanupAbort();
				reject(
					new Error(
						`Failed to send MCP request (${this.options.serverId}): ${describeError(error)}`,
					),
				);
			});
		});
	}

	async notify(method: string, params: unknown): Promise<void> {
		await this.writeJsonRpc({
			jsonrpc: JSON_RPC_VERSION,
			method,
			params,
		});
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.failAllPending(
			new Error(`mcp stdio closed: ${this.options.serverId}`),
		);
		this.closePromise = new Promise<void>((resolve, reject) => {
			const groupId = process.platform === "win32" ? undefined : this.child.pid;
			let forceTimer: ReturnType<typeof setTimeout>;
			let deadline: ReturnType<typeof setTimeout>;
			let poll: ReturnType<typeof setInterval>;
			let settled = false;
			const cleanup = () => {
				clearTimeout(forceTimer);
				clearTimeout(deadline);
				clearInterval(poll);
				this.child.removeListener("exit", check);
				this.child.removeListener("close", check);
				this.child.removeListener("error", check);
			};
			const done = () => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve();
			};
			const alive = (): boolean => {
				if (!this.child.pid) return false;
				if (groupId) {
					try {
						process.kill(-groupId, 0);
						return true;
					} catch (error) {
						return (error as NodeJS.ErrnoException).code !== "ESRCH";
					}
				}
				return this.child.exitCode === null && this.child.signalCode === null;
			};
			const check = () => {
				if (!alive()) done();
			};
			const signal = (name: NodeJS.Signals) => {
				try {
					if (groupId) process.kill(-groupId, name);
					else this.child.kill(name);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
						this.options.log(
							`mcp[${this.options.serverId}] process termination failed`,
						);
						if (groupId) {
							try {
								this.child.kill(name);
							} catch {
								/* bounded wait reports failure */
							}
						}
					}
				}
			};
			this.child.once("exit", check);
			this.child.once("close", check);
			this.child.once("error", check);
			poll = setInterval(check, 20);
			forceTimer = setTimeout(() => signal("SIGKILL"), 500);
			deadline = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(
					new Error(
						`mcp stdio process group did not exit: ${this.options.serverId}`,
					),
				);
			}, 1_500);
			if (process.platform === "win32" && this.child.pid) {
				const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
				const taskkill = systemRoot
					? path.join(systemRoot, "System32", "taskkill.exe")
					: "taskkill.exe";
				try {
					const killer = spawn(
						taskkill,
						["/PID", String(this.child.pid), "/T", "/F"],
						{
							stdio: "ignore",
							windowsHide: true,
						},
					);
					killer.once("error", () => signal("SIGTERM"));
					killer.once("exit", (code) => {
						if (code !== 0) signal("SIGTERM");
					});
				} catch {
					signal("SIGTERM");
				}
			} else {
				signal("SIGTERM");
			}
			check();
		});
		return this.closePromise;
	}
}
