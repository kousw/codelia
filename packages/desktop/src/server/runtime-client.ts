import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type {
	InitializeResult,
	RpcMessage,
	RpcRequest,
	RpcResponse,
} from "../../../protocol/src/index";

type RuntimeListener = (message: RpcMessage) => void;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export class RuntimeClient {
	private child: ChildProcessWithoutNullStreams | null = null;
	private readonly workspacePath: string;
	private readonly runtimeEntryPath: string;
	private readonly listeners = new Set<RuntimeListener>();
	private readonly pending = new Map<string, PendingRequest>();
	private nextId = 0;
	private buffer = "";
	private started = false;
	private initializePromise: Promise<InitializeResult> | null = null;
	private lastError: string | undefined;

	constructor(workspacePath: string, runtimeEntryPath: string) {
		this.workspacePath = workspacePath;
		this.runtimeEntryPath = runtimeEntryPath;
	}

	get connected(): boolean {
		return this.child !== null && !this.child.killed;
	}

	get initializing(): boolean {
		return this.initializePromise !== null;
	}

	get error(): string | undefined {
		return this.lastError;
	}

	get pendingRequestCount(): number {
		return this.pending.size;
	}

	subscribe(listener: RuntimeListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	async ensureStarted(): Promise<InitializeResult> {
		if (this.initializePromise) {
			return this.initializePromise;
		}
		if (!this.started) {
			this.start();
		}
		this.initializePromise = this.request("initialize", {
			protocol_version: "0",
			client: { name: "@codelia/desktop", version: "0.0.1" },
			ui_capabilities: {
				supports_confirm: true,
				supports_prompt: true,
				supports_pick: true,
				supports_markdown: true,
				supports_images: true,
				supports_generated_ui: true,
				supports_permission_preflight_events: true,
			},
		}) as Promise<InitializeResult>;
		try {
			return await this.initializePromise;
		} finally {
			this.initializePromise = null;
		}
	}

	async request<T = unknown>(method: string, params?: unknown): Promise<T> {
		await this.ensureProcess();
		const id = `desktop_${++this.nextId}`;
		const payload: RpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params,
		};
		const child = this.child;
		if (!child) {
			throw new Error("runtime is not available");
		}
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
			});
		});
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		return promise;
	}

	async notify(method: string, params?: unknown): Promise<void> {
		await this.ensureProcess();
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
		);
	}

	async respond(id: string, result: unknown): Promise<void> {
		await this.ensureProcess();
		this.child?.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`,
		);
	}

	dispose(reason = "runtime disposed"): void {
		this.lastError = reason;
		this.initializePromise = null;
		this.started = false;
		this.buffer = "";
		const child = this.child;
		this.child = null;
		this.rejectPending(new Error(reason));
		if (child && !child.killed) {
			child.kill();
		}
	}

	private async ensureProcess(): Promise<void> {
		if (!this.started) {
			this.start();
		}
		if (!this.child) {
			throw new Error("runtime failed to start");
		}
	}

	private start(): void {
		this.started = true;
		const child = spawn(process.execPath, [this.runtimeEntryPath], {
			cwd: this.workspacePath,
			env: {
				...process.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			this.buffer += chunk;
			this.drainBuffer();
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.lastError = chunk.trim() || this.lastError;
		});
		child.on("exit", (code, signal) => {
			this.lastError = `runtime exited (code=${String(code)} signal=${String(signal)})`;
			this.child = null;
			this.rejectPending(new Error(this.lastError));
		});
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending.entries()) {
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	private drainBuffer(): void {
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				this.handleLine(line);
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let parsed: RpcMessage;
		try {
			parsed = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (
			isObject(parsed) &&
			"id" in parsed &&
			("result" in parsed || "error" in parsed)
		) {
			this.handleResponse(parsed as RpcResponse);
			return;
		}
		this.emit(parsed);
	}

	private handleResponse(message: RpcResponse): void {
		const pending = this.pending.get(message.id);
		if (!pending) {
			this.emit(message);
			return;
		}
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message));
			return;
		}
		pending.resolve(message.result);
	}

	private emit(message: RpcMessage): void {
		for (const listener of this.listeners) {
			listener(message);
		}
	}
}
