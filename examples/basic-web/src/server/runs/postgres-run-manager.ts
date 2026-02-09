import crypto from "node:crypto";
import { SQL } from "bun";
import type { AgentPool } from "../agent/agent-pool";
import type {
	RunBackend,
	RunEventRecord,
	RunStatus,
	RunView,
	WaitResult,
} from "./run-manager";

type ClaimRow = {
	run_id: string;
	session_id: string;
	input_text: string;
};

const POLL_SLEEP_MS = 250;
const CANCEL_CHECK_INTERVAL_MS = 750;
const SCHEMA_LOCK_ID = 6_204_202_601;
const DEFAULT_SESSION_STICKY_SECONDS = 10 * 60;
const MIN_SESSION_STICKY_SECONDS = 10;
const MAX_SESSION_STICKY_SECONDS = 24 * 60 * 60;

const parseSessionStickySeconds = (value?: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_SESSION_STICKY_SECONDS;
	}
	const normalized = Math.floor(value);
	return Math.max(
		MIN_SESSION_STICKY_SECONDS,
		Math.min(MAX_SESSION_STICKY_SECONDS, normalized),
	);
};

const isAbortError = (error: unknown): boolean => {
	const err = error instanceof Error ? error : new Error(String(error));
	if (err.name === "AbortError" || err.name === "APIUserAbortError") {
		return true;
	}
	return /abort/i.test(err.message);
};

const sleep = async (delayMs: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const parsePayload = (payload: unknown): Record<string, unknown> => {
	if (payload && typeof payload === "object") {
		return payload as Record<string, unknown>;
	}
	if (typeof payload === "string") {
		try {
			const parsed = JSON.parse(payload);
			if (parsed && typeof parsed === "object") {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// ignore invalid payload
		}
	}
	return {};
};

const asNumberOrUndefined = (value: unknown): number | undefined => {
	if (value === null || value === undefined) return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
};

const asRunStatus = (value: unknown): RunStatus => {
	if (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	) {
		return value;
	}
	return "failed";
};

export class PostgresRunManager implements RunBackend {
	private readonly sql: SQL;
	private readonly pool: AgentPool;
	private readonly workerId: string;
	private readonly leaseSeconds: number;
	private readonly sessionStickySeconds: number;
	private readonly claimPollMs: number;
	private readonly enableWorker: boolean;
	private disposed = false;
	private readonly ready: Promise<void>;
	private workerLoop: Promise<void> | null = null;

	constructor(
		pool: AgentPool,
		options: {
			databaseUrl: string;
			workerId?: string;
			leaseSeconds?: number;
			sessionStickySeconds?: number;
			claimPollMs?: number;
			enableWorker?: boolean;
		},
	) {
		this.pool = pool;
		this.sql = new SQL(options.databaseUrl);
		this.workerId =
			options.workerId ?? `worker-${process.pid}-${crypto.randomUUID()}`;
		this.leaseSeconds = Math.max(10, Math.floor(options.leaseSeconds ?? 30));
		const sessionStickyFromEnv = Number(
			process.env.CODELIA_SESSION_STICKY_TTL_SECONDS,
		);
		this.sessionStickySeconds = parseSessionStickySeconds(
			options.sessionStickySeconds ??
				(Number.isFinite(sessionStickyFromEnv)
					? sessionStickyFromEnv
					: undefined),
		);
		this.claimPollMs = Math.max(200, Math.floor(options.claimPollMs ?? 1000));
		this.enableWorker = options.enableWorker ?? true;
		this.ready = this.initSchema();
		if (this.enableWorker) {
			this.workerLoop = this.runWorkerLoop();
		}
	}

	async createRun(input: {
		sessionId: string;
		message: string;
	}): Promise<{ runId: string; status: "queued" }> {
		await this.ready;
		const runId = crypto.randomUUID();
		await this.sql`
			insert into runs (
				run_id,
				session_id,
				status,
				input_text
			) values (
				${runId},
				${input.sessionId},
				${"queued"},
				${input.message}
			)
		`;
		return { runId, status: "queued" };
	}

	async getRun(runId: string): Promise<RunView | null> {
		await this.ready;
		const rows = await this.sql<
			Array<{
				run_id: string;
				session_id: string;
				input_text: string;
				status: string;
				created_at: number;
				started_at: number | null;
				finished_at: number | null;
				cancel_requested_at: number | null;
				error_message: string | null;
			}>
		>`
			select
				run_id,
				session_id,
				input_text,
				status,
				(extract(epoch from created_at) * 1000)::bigint as created_at,
				(extract(epoch from started_at) * 1000)::bigint as started_at,
				(extract(epoch from finished_at) * 1000)::bigint as finished_at,
				(extract(epoch from cancel_requested_at) * 1000)::bigint as cancel_requested_at,
				error_message
			from runs
			where run_id = ${runId}
			limit 1
		`;
		const row = rows[0];
		if (!row) return null;
		return {
			run_id: row.run_id,
			session_id: row.session_id,
			input_text: row.input_text,
			status: asRunStatus(row.status),
			created_at: Number(row.created_at),
			started_at: asNumberOrUndefined(row.started_at),
			finished_at: asNumberOrUndefined(row.finished_at),
			cancel_requested_at: asNumberOrUndefined(row.cancel_requested_at),
			error_message: row.error_message ?? undefined,
		};
	}

	async listRuns(input: {
		sessionId: string;
		statuses?: RunStatus[];
		limit?: number;
	}): Promise<RunView[]> {
		await this.ready;
		const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
		const fetchLimit = Math.min(500, Math.max(limit * 5, 100));
		const rows = await this.sql<
			Array<{
				run_id: string;
				session_id: string;
				input_text: string;
				status: string;
				created_at: number;
				started_at: number | null;
				finished_at: number | null;
				cancel_requested_at: number | null;
				error_message: string | null;
			}>
		>`
			select
				run_id,
				session_id,
				input_text,
				status,
				(extract(epoch from created_at) * 1000)::bigint as created_at,
				(extract(epoch from started_at) * 1000)::bigint as started_at,
				(extract(epoch from finished_at) * 1000)::bigint as finished_at,
				(extract(epoch from cancel_requested_at) * 1000)::bigint as cancel_requested_at,
				error_message
			from runs
			where session_id = ${input.sessionId}
			order by created_at desc
			limit ${fetchLimit}
		`;
		const allowedStatuses =
			input.statuses && input.statuses.length > 0
				? new Set(input.statuses)
				: null;
		return rows
			.map((row) => ({
				run_id: row.run_id,
				session_id: row.session_id,
				input_text: row.input_text,
				status: asRunStatus(row.status),
				created_at: Number(row.created_at),
				started_at: asNumberOrUndefined(row.started_at),
				finished_at: asNumberOrUndefined(row.finished_at),
				cancel_requested_at: asNumberOrUndefined(row.cancel_requested_at),
				error_message: row.error_message ?? undefined,
			}))
			.filter((run) =>
				allowedStatuses ? allowedStatuses.has(run.status) : true,
			)
			.slice(0, limit);
	}

	async listEventsAfter(
		runId: string,
		afterSeq: number,
		limit = 100,
	): Promise<RunEventRecord[]> {
		await this.ready;
		const rows = await this.sql<
			Array<{
				seq: number;
				event_type: string;
				payload: unknown;
				created_at: number;
			}>
		>`
			select
				seq,
				event_type,
				payload,
				(extract(epoch from created_at) * 1000)::bigint as created_at
			from run_events
			where run_id = ${runId}
				and seq > ${afterSeq}
			order by seq asc
			limit ${Math.max(0, limit)}
		`;
		return rows.map((row) => ({
			seq: Number(row.seq),
			type: row.event_type,
			data: parsePayload(row.payload),
			createdAt: Number(row.created_at),
		}));
	}

	async requestCancel(runId: string): Promise<boolean> {
		await this.ready;
		const rows = await this.sql<Array<{ run_id: string }>>`
			update runs
			set cancel_requested_at = coalesce(cancel_requested_at, now())
			where run_id = ${runId}
			returning run_id
		`;
		return rows.length > 0;
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
		const deadline = Date.now() + Math.max(100, timeoutMs);
		while (Date.now() < deadline) {
			if (signal?.aborted || this.disposed) return "aborted";
			const run = await this.getRun(runId);
			if (!run) return "missing";
			const events = await this.listEventsAfter(runId, afterSeq, 1);
			if (events.length > 0) return "event";
			await sleep(POLL_SLEEP_MS, signal);
		}
		return signal?.aborted ? "aborted" : "timeout";
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.workerLoop) {
			await this.workerLoop.catch(() => {});
		}
		await this.sql.close().catch(() => {});
	}

	private async initSchema(): Promise<void> {
		await this.sql`select pg_advisory_lock(${SCHEMA_LOCK_ID})`;
		try {
			await this.sql`
				create table if not exists runs (
					run_id text primary key,
					session_id text not null,
					status text not null check (status in ('queued','running','completed','failed','cancelled')),
					input_text text not null,
					created_at timestamptz not null default now(),
					started_at timestamptz,
					finished_at timestamptz,
					owner_id text,
					lease_until timestamptz,
					cancel_requested_at timestamptz,
					error_message text
				)
			`;
			await this.sql`
				create index if not exists runs_status_created_idx
				on runs(status, created_at)
			`;
			await this.sql`
				create index if not exists runs_owner_idx
				on runs(owner_id)
			`;
			await this.sql`
				create table if not exists worker_session_leases (
					session_id text primary key,
					worker_id text not null,
					lease_until timestamptz not null,
					updated_at timestamptz not null default now()
				)
			`;
			await this.sql`
				create index if not exists worker_session_leases_worker_idx
				on worker_session_leases(worker_id, lease_until)
			`;
			await this.sql`
				create table if not exists run_events (
					run_id text not null references runs(run_id) on delete cascade,
					seq bigint not null,
					event_type text not null,
					payload jsonb not null,
					created_at timestamptz not null default now(),
					primary key (run_id, seq)
				)
			`;
			await this.sql`
				create index if not exists run_events_created_idx
				on run_events(run_id, created_at)
			`;
			await this.sql`
				delete from worker_session_leases
				where lease_until <= now()
			`;
		} finally {
			await this.sql`select pg_advisory_unlock(${SCHEMA_LOCK_ID})`;
		}
	}

	private async runWorkerLoop(): Promise<void> {
		await this.ready;
		while (!this.disposed) {
			try {
				const claim = await this.claimRun();
				if (!claim) {
					await sleep(this.claimPollMs);
					continue;
				}
				await this.executeClaimedRun(claim);
			} catch (error) {
				console.error(`[runs-worker] loop error: ${String(error)}`);
				await sleep(this.claimPollMs);
			}
		}
	}

	private async claimRun(): Promise<ClaimRow | null> {
		return this.sql.begin(async (tx) => {
			await tx`
				delete from worker_session_leases
				where lease_until <= now()
			`;

			const stickyCandidates = await tx<
				Array<{
					run_id: string;
					session_id: string;
					input_text: string;
				}>
			>`
				select
					r.run_id,
					r.session_id,
					r.input_text
				from runs r
				inner join worker_session_leases sl
					on sl.session_id = r.session_id
				where sl.worker_id = ${this.workerId}
					and sl.lease_until > now()
					and (
						r.status = ${"queued"}
						or (r.status = ${"running"} and r.lease_until < now())
					)
				order by r.created_at asc
				for update of r skip locked
				limit 1
			`;
			let candidate = stickyCandidates[0];
			if (!candidate) {
				const fallbackCandidates = await tx<
					Array<{
						run_id: string;
						session_id: string;
						input_text: string;
					}>
				>`
					select
						r.run_id,
						r.session_id,
						r.input_text
					from runs r
					left join worker_session_leases sl
						on sl.session_id = r.session_id
						and sl.lease_until > now()
					where (
						r.status = ${"queued"}
						or (r.status = ${"running"} and r.lease_until < now())
					)
						and (
							sl.session_id is null
							or sl.worker_id = ${this.workerId}
						)
					order by r.created_at asc
					for update of r skip locked
					limit 1
				`;
				candidate = fallbackCandidates[0];
			}
			if (!candidate) return null;
			await tx`
				update runs
				set
					status = ${"running"},
					owner_id = ${this.workerId},
					lease_until = now() + make_interval(secs => ${this.leaseSeconds}),
					started_at = coalesce(started_at, now())
				where run_id = ${candidate.run_id}
			`;
			await tx`
				insert into worker_session_leases (
					session_id,
					worker_id,
					lease_until,
					updated_at
				) values (
					${candidate.session_id},
					${this.workerId},
					now() + make_interval(secs => ${this.sessionStickySeconds}),
					now()
				)
				on conflict (session_id)
				do update set
					worker_id = excluded.worker_id,
					lease_until = excluded.lease_until,
					updated_at = excluded.updated_at
			`;
			return {
				run_id: candidate.run_id,
				session_id: candidate.session_id,
				input_text: candidate.input_text,
			};
		});
	}

	private async executeClaimedRun(claim: ClaimRow): Promise<void> {
		let abortReason: "cancelled" | "failed" | null = null;
		let nextCancelCheckAt = 0;
		const abortController = new AbortController();
		const isCancelled = async (): Promise<boolean> => {
			const rows = await this.sql<Array<{ requested: boolean }>>`
				select cancel_requested_at is not null as requested
				from runs
				where run_id = ${claim.run_id}
				limit 1
			`;
			return Boolean(rows[0]?.requested);
		};
		const leaseTimer = setInterval(async () => {
			try {
				const ok = await this.renewLease(claim.run_id, claim.session_id);
				if (!ok && !abortController.signal.aborted) {
					abortReason = "failed";
					abortController.abort(new Error("worker lease lost"));
				}
			} catch {
				if (!abortController.signal.aborted) {
					abortReason = "failed";
					abortController.abort(new Error("lease renewal failed"));
				}
			}
		}, 10_000);

		const checkCancel = async () => {
			if (Date.now() < nextCancelCheckAt) return;
			nextCancelCheckAt = Date.now() + CANCEL_CHECK_INTERVAL_MS;
			if (await isCancelled()) {
				abortReason = "cancelled";
				abortController.abort(new Error("cancel requested"));
			}
		};

		try {
			await checkCancel();
			await this.pool.runWithLock(claim.session_id, async (entry) => {
				for await (const event of entry.agent.runStream(claim.input_text, {
					signal: abortController.signal,
				})) {
					if (abortController.signal.aborted) break;
					await this.appendEvent(
						claim.run_id,
						event.type,
						event as unknown as Record<string, unknown>,
					);
					await checkCancel();
				}
				if (!abortController.signal.aborted) {
					await this.appendEvent(claim.run_id, "done", { status: "completed" });
					await this.finishRun(claim.run_id, "completed");
				}
			});
		} catch (error) {
			const cancelled =
				abortReason === "cancelled" ||
				(isAbortError(error) && (await isCancelled()));
			if (cancelled) {
				await this.appendEvent(claim.run_id, "done", { status: "cancelled" });
				await this.finishRun(claim.run_id, "cancelled");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				await this.appendEvent(claim.run_id, "error", { message });
				await this.appendEvent(claim.run_id, "done", { status: "error" });
				await this.finishRun(claim.run_id, "failed", message);
			}
		} finally {
			clearInterval(leaseTimer);
			try {
				await this.pool.saveSession(claim.session_id);
			} catch (error) {
				console.error(
					`[runs-worker][${claim.run_id}] session save error: ${String(error)}`,
				);
			}
		}
	}

	private async renewLease(runId: string, sessionId: string): Promise<boolean> {
		const rows = await this.sql<Array<{ ok: number }>>`
			update runs
			set lease_until = now() + make_interval(secs => ${this.leaseSeconds})
			where run_id = ${runId}
				and owner_id = ${this.workerId}
				and status = ${"running"}
			returning 1 as ok
		`;
		if (rows.length === 0) return false;
		await this.sql`
			insert into worker_session_leases (
				session_id,
				worker_id,
				lease_until,
				updated_at
			) values (
				${sessionId},
				${this.workerId},
				now() + make_interval(secs => ${this.sessionStickySeconds}),
				now()
			)
			on conflict (session_id)
			do update set
				worker_id = excluded.worker_id,
				lease_until = excluded.lease_until,
				updated_at = excluded.updated_at
		`;
		return true;
	}

	private async finishRun(
		runId: string,
		status: "completed" | "failed" | "cancelled",
		errorMessage?: string,
	): Promise<void> {
		await this.sql`
			update runs
			set
				status = ${status},
				finished_at = now(),
				owner_id = null,
				lease_until = null,
				error_message = ${
					status === "failed" ? (errorMessage ?? "run failed") : null
				}
			where run_id = ${runId}
		`;
	}

	private async appendEvent(
		runId: string,
		type: string,
		data: Record<string, unknown>,
	): Promise<void> {
		const payload = JSON.stringify(data);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const rows = await this.sql<Array<{ next_seq: number }>>`
				select coalesce(max(seq), -1) + 1 as next_seq
				from run_events
				where run_id = ${runId}
			`;
			const nextSeq = Number(rows[0]?.next_seq ?? 0);
			try {
				await this.sql`
					insert into run_events (run_id, seq, event_type, payload)
					values (${runId}, ${nextSeq}, ${type}, ${payload}::jsonb)
				`;
				return;
			} catch (error) {
				if (error instanceof SQL.PostgresError && error.code === "23505") {
					continue;
				}
				throw error;
			}
		}
		throw new Error(`failed to append event: run_id=${runId} type=${type}`);
	}
}
