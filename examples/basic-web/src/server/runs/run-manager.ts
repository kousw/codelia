import crypto from "node:crypto";
import type { AgentPool } from "../agent/agent-pool";

export type RunStatus =
	| "queued"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export type RunView = {
	run_id: string;
	session_id: string;
	input_text?: string;
	status: RunStatus;
	created_at: number;
	started_at?: number;
	finished_at?: number;
	cancel_requested_at?: number;
	error_message?: string;
};

export type RunEventRecord = {
	seq: number;
	type: string;
	data: Record<string, unknown>;
	createdAt: number;
};

export type RunBackend = {
	createRun(input: { sessionId: string; message: string }): Promise<{
		runId: string;
		status: "queued";
	}>;
	getRun(runId: string): RunView | null | Promise<RunView | null>;
	listRuns(input: {
		sessionId: string;
		statuses?: RunStatus[];
		limit?: number;
	}): RunView[] | Promise<RunView[]>;
	listEventsAfter(
		runId: string,
		afterSeq: number,
		limit?: number,
	): RunEventRecord[] | Promise<RunEventRecord[]>;
	requestCancel(runId: string): boolean | Promise<boolean>;
	isTerminalStatus(status: RunStatus): boolean;
	waitForNewEvent(
		runId: string,
		afterSeq: number,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<WaitResult>;
	dispose(): void | Promise<void>;
};

type RunRecord = {
	runId: string;
	sessionId: string;
	message: string;
	status: RunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	cancelRequestedAt?: number;
	errorMessage?: string;
	abortController: AbortController | null;
	events: RunEventRecord[];
	nextSeq: number;
	listeners: Set<() => void>;
};

export type WaitResult = "event" | "timeout" | "aborted" | "missing";

const ABORT_ERROR_NAMES = new Set(["AbortError", "APIUserAbortError"]);
const TERMINAL_RETENTION_MS = 30 * 60 * 1000;
const GC_INTERVAL_MS = 5 * 60 * 1000;

const isAbortError = (error: unknown): boolean => {
	const err = error instanceof Error ? error : new Error(String(error));
	if (ABORT_ERROR_NAMES.has(err.name)) return true;
	return /abort/i.test(err.message);
};

export class RunManager implements RunBackend {
	private readonly runs = new Map<string, RunRecord>();
	private readonly pool: AgentPool;
	private gcTimer: ReturnType<typeof setInterval> | null = null;

	constructor(pool: AgentPool) {
		this.pool = pool;
		this.gcTimer = setInterval(
			() => this.evictTerminatedRuns(),
			GC_INTERVAL_MS,
		);
	}

	async createRun(input: { sessionId: string; message: string }): Promise<{
		runId: string;
		status: "queued";
	}> {
		const runId = crypto.randomUUID();
		const record: RunRecord = {
			runId,
			sessionId: input.sessionId,
			message: input.message,
			status: "queued",
			createdAt: Date.now(),
			abortController: null,
			events: [],
			nextSeq: 0,
			listeners: new Set(),
		};
		this.runs.set(runId, record);
		this.notify(record);
		void this.startRun(record).catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			this.failRun(record, message);
		});
		return { runId, status: "queued" };
	}

	getRun(runId: string): RunView | null {
		const run = this.runs.get(runId);
		if (!run) return null;
		return {
			run_id: run.runId,
			session_id: run.sessionId,
			input_text: run.message,
			status: run.status,
			created_at: run.createdAt,
			started_at: run.startedAt,
			finished_at: run.finishedAt,
			cancel_requested_at: run.cancelRequestedAt,
			error_message: run.errorMessage,
		};
	}

	listRuns(input: {
		sessionId: string;
		statuses?: RunStatus[];
		limit?: number;
	}): RunView[] {
		const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
		const allowedStatuses =
			input.statuses && input.statuses.length > 0
				? new Set(input.statuses)
				: null;

		return Array.from(this.runs.values())
			.filter((run) => {
				if (run.sessionId !== input.sessionId) return false;
				if (allowedStatuses && !allowedStatuses.has(run.status)) return false;
				return true;
			})
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit)
			.map((run) => ({
				run_id: run.runId,
				session_id: run.sessionId,
				input_text: run.message,
				status: run.status,
				created_at: run.createdAt,
				started_at: run.startedAt,
				finished_at: run.finishedAt,
				cancel_requested_at: run.cancelRequestedAt,
				error_message: run.errorMessage,
			}));
	}

	listEventsAfter(
		runId: string,
		afterSeq: number,
		limit = 100,
	): RunEventRecord[] {
		const run = this.runs.get(runId);
		if (!run) return [];
		return run.events
			.filter((event) => event.seq > afterSeq)
			.slice(0, Math.max(0, limit));
	}

	requestCancel(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run) return false;
		run.cancelRequestedAt = run.cancelRequestedAt ?? Date.now();
		if (!this.isTerminalStatus(run.status)) {
			run.abortController?.abort(new Error("cancelled by user"));
		}
		this.notify(run);
		return true;
	}

	isTerminalStatus(status: RunStatus): boolean {
		return (
			status === "completed" || status === "failed" || status === "cancelled"
		);
	}

	async waitForNewEvent(
		runId: string,
		afterSeq: number,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<WaitResult> {
		const run = this.runs.get(runId);
		if (!run) return "missing";
		if (this.listEventsAfter(runId, afterSeq, 1).length > 0) return "event";
		if (signal?.aborted) return "aborted";
		return new Promise<WaitResult>((resolve) => {
			let settled = false;
			const finish = (result: WaitResult) => {
				if (settled) return;
				settled = true;
				unsubscribe();
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => finish("aborted");
			const unsubscribe = this.subscribe(runId, () => finish("event"));
			const timer = setTimeout(
				() => finish("timeout"),
				Math.max(100, timeoutMs),
			);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	dispose(): void {
		if (this.gcTimer) {
			clearInterval(this.gcTimer);
			this.gcTimer = null;
		}
		for (const run of this.runs.values()) {
			run.abortController?.abort(new Error("run manager disposed"));
			run.listeners.clear();
		}
		this.runs.clear();
	}

	private subscribe(runId: string, listener: () => void): () => void {
		const run = this.runs.get(runId);
		if (!run) {
			return () => {};
		}
		run.listeners.add(listener);
		return () => {
			run.listeners.delete(listener);
		};
	}

	private notify(run: RunRecord): void {
		for (const listener of run.listeners) {
			listener();
		}
	}

	private appendEvent(
		run: RunRecord,
		type: string,
		data: Record<string, unknown>,
	): RunEventRecord {
		const record: RunEventRecord = {
			seq: run.nextSeq++,
			type,
			data,
			createdAt: Date.now(),
		};
		run.events.push(record);
		this.notify(run);
		return record;
	}

	private completeRun(run: RunRecord, status: "completed" | "cancelled"): void {
		if (this.isTerminalStatus(run.status)) return;
		this.appendEvent(run, "done", {
			status: status === "completed" ? "completed" : "cancelled",
		});
		run.status = status;
		run.finishedAt = Date.now();
		this.notify(run);
	}

	private failRun(run: RunRecord, message: string): void {
		if (this.isTerminalStatus(run.status)) return;
		run.errorMessage = message;
		this.appendEvent(run, "error", { message });
		this.appendEvent(run, "done", { status: "error" });
		run.status = "failed";
		run.finishedAt = Date.now();
		this.notify(run);
	}

	private async startRun(run: RunRecord): Promise<void> {
		if (this.isTerminalStatus(run.status)) return;
		run.status = "running";
		run.startedAt = Date.now();
		this.notify(run);

		await this.pool.runWithLock(run.sessionId, async (entry) => {
			const abortController = new AbortController();
			run.abortController = abortController;
			if (run.cancelRequestedAt) {
				abortController.abort(new Error("cancelled before run start"));
			}
			try {
				for await (const event of entry.agent.runStream(run.message, {
					signal: abortController.signal,
				})) {
					if (abortController.signal.aborted) break;
					this.appendEvent(
						run,
						event.type,
						event as unknown as Record<string, unknown>,
					);
				}
				if (!abortController.signal.aborted) {
					this.completeRun(run, "completed");
				}
			} catch (error) {
				if (isAbortError(error)) {
					this.completeRun(run, "cancelled");
				} else {
					const message =
						error instanceof Error ? error.message : String(error);
					this.failRun(run, message);
				}
			} finally {
				run.abortController = null;
				try {
					await this.pool.saveSession(run.sessionId);
				} catch (error) {
					console.error(
						`[run-manager][${run.runId}] session save error: ${String(error)}`,
					);
				}
			}
		});
	}

	private evictTerminatedRuns(): void {
		const now = Date.now();
		for (const [runId, run] of this.runs) {
			if (!this.isTerminalStatus(run.status)) continue;
			if (!run.finishedAt) continue;
			if (now - run.finishedAt < TERMINAL_RETENTION_MS) continue;
			this.runs.delete(runId);
		}
	}
}
