import type { SessionState, SessionStateSummary } from "@codelia/core";
import { SQL } from "bun";
import type { SessionManagerLike } from "./session-manager";

const SCHEMA_LOCK_ID = 6_204_202_601;

const parseSessionState = (value: unknown): SessionState | null => {
	let normalized = value;
	if (typeof normalized === "string") {
		try {
			normalized = JSON.parse(normalized);
		} catch {
			return null;
		}
	}
	if (!normalized || typeof normalized !== "object") return null;
	const candidate = normalized as Partial<SessionState>;
	if (candidate.schema_version !== 1) return null;
	if (typeof candidate.session_id !== "string" || !candidate.session_id)
		return null;
	if (typeof candidate.updated_at !== "string" || !candidate.updated_at)
		return null;
	if (!Array.isArray(candidate.messages)) return null;
	return {
		schema_version: 1,
		session_id: candidate.session_id,
		updated_at: candidate.updated_at,
		run_id:
			typeof candidate.run_id === "string" && candidate.run_id
				? candidate.run_id
				: undefined,
		invoke_seq:
			typeof candidate.invoke_seq === "number" &&
			Number.isFinite(candidate.invoke_seq)
				? candidate.invoke_seq
				: undefined,
		messages: candidate.messages,
		meta:
			candidate.meta && typeof candidate.meta === "object"
				? (candidate.meta as Record<string, unknown>)
				: undefined,
	};
};

const resolveLastUserMessage = (state: SessionState): string | undefined => {
	for (let i = state.messages.length - 1; i >= 0; i -= 1) {
		const msg = state.messages[i] as { role?: string; content?: unknown };
		if (msg?.role !== "user") continue;
		if (typeof msg.content === "string") return msg.content;
		if (Array.isArray(msg.content)) {
			return msg.content
				.map((part: { type?: string; text?: string }) =>
					part?.type === "text" ? (part.text ?? "") : "",
				)
				.join("");
		}
		return String(msg.content ?? "");
	}
	return undefined;
};

export class PostgresSessionManager implements SessionManagerLike {
	private readonly sql: SQL;
	private readonly ready: Promise<void>;

	constructor(databaseUrl: string) {
		this.sql = new SQL(databaseUrl);
		this.ready = this.initSchema();
	}

	async list(): Promise<SessionStateSummary[]> {
		await this.ready;
		const rows = await this.sql<
			Array<{
				session_id: string;
				updated_at: string;
				state_json: unknown;
			}>
		>`
			select
				session_id,
				to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at,
				state_json
			from session_states
			order by updated_at desc
		`;
		const summaries: SessionStateSummary[] = [];
		for (const row of rows) {
			const state = parseSessionState(row.state_json);
			if (!state) continue;
			summaries.push({
				session_id: state.session_id,
				updated_at: state.updated_at,
				run_id: state.run_id,
				message_count: state.messages.length,
				last_user_message: resolveLastUserMessage(state),
			});
		}
		return summaries;
	}

	async load(sessionId: string): Promise<SessionState | null> {
		await this.ready;
		const rows = await this.sql<Array<{ state_json: unknown }>>`
			select state_json
			from session_states
			where session_id = ${sessionId}
			limit 1
		`;
		const row = rows[0];
		if (!row) return null;
		return parseSessionState(row.state_json);
	}

	async save(state: SessionState): Promise<void> {
		await this.ready;
		await this.sql`
			insert into session_states (
				session_id,
				updated_at,
				state_json
			) values (
				${state.session_id},
				${state.updated_at}::timestamptz,
				${JSON.stringify(state)}::jsonb
			)
			on conflict (session_id)
			do update set
				updated_at = excluded.updated_at,
				state_json = excluded.state_json
		`;
	}

	async delete(sessionId: string): Promise<boolean> {
		await this.ready;
		const rows = await this.sql<Array<{ session_id: string }>>`
			delete from session_states
			where session_id = ${sessionId}
			returning session_id
		`;
		return rows.length > 0;
	}

	async dispose(): Promise<void> {
		await this.sql.close().catch(() => {});
	}

	private async initSchema(): Promise<void> {
		await this.sql`select pg_advisory_lock(${SCHEMA_LOCK_ID})`;
		try {
			await this.sql`
				create table if not exists session_states (
					session_id text primary key,
					updated_at timestamptz not null,
					state_json jsonb not null
				)
			`;
			await this.sql`
				create index if not exists session_states_updated_idx
				on session_states(updated_at desc)
			`;
		} finally {
			await this.sql`select pg_advisory_unlock(${SCHEMA_LOCK_ID})`;
		}
	}
}
