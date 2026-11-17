import type { GoalRecord } from "@codelia/shared-types";

export type GoalRunClaim = {
	run_id: string;
	revision: number;
	activation_id: string;
	continuation_id?: string;
	owner_pid: number;
	owner_identity: string | null;
	pending_seq?: number;
	accounted_seq?: number;
};

export type StoredSessionGoal = {
	goal: GoalRecord;
	claim?: GoalRunClaim;
	blocker?: { key: string; runs: number };
};

type Sqlite = {
	exec(sql: string): void;
	run(sql: string, params?: unknown[]): void;
	get<T>(sql: string, params?: unknown[]): T | undefined;
};

export type GoalTransaction = {
	entry: StoredSessionGoal | null;
	consume(continuationId: string, goalId: string, runId: string): void;
};

export function initSessionGoals(db: Sqlite): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS session_goals (
			session_id TEXT PRIMARY KEY,
			payload TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS goal_continuations (
			continuation_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			goal_id TEXT NOT NULL,
			run_id TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS goal_continuations_session ON goal_continuations (session_id);
	`);
}

export class SessionGoalStore {
	constructor(private readonly getDb: () => Promise<Sqlite>) {}

	private load(db: Sqlite, sessionId: string): StoredSessionGoal | null {
		const row = db.get<{ payload: string }>(
			"SELECT payload FROM session_goals WHERE session_id = ?",
			[sessionId],
		);
		return row ? (JSON.parse(row.payload) as StoredSessionGoal) : null;
	}

	async read(
		sessionId: string,
		continuationId?: string,
	): Promise<{
		entry: StoredSessionGoal | null;
		acceptedRunId?: string;
	}> {
		const db = await this.getDb();
		const entry = this.load(db, sessionId);
		const acceptedRunId =
			continuationId && entry
				? db.get<{ run_id: string }>(
						"SELECT run_id FROM goal_continuations WHERE session_id = ? AND goal_id = ? AND continuation_id = ?",
						[sessionId, entry.goal.goal_id, continuationId],
					)?.run_id
				: undefined;
		return { entry, acceptedRunId };
	}

	async update<T>(
		sessionId: string,
		update: (tx: GoalTransaction) => T,
	): Promise<T> {
		const db = await this.getDb();
		db.exec("BEGIN IMMEDIATE");
		try {
			const tx: GoalTransaction = {
				entry: this.load(db, sessionId),
				consume: (continuationId, goalId, runId) =>
					db.run(
						"INSERT INTO goal_continuations (continuation_id, session_id, goal_id, run_id) VALUES (?, ?, ?, ?)",
						[continuationId, sessionId, goalId, runId],
					),
			};
			const result = update(tx);
			if (tx.entry) {
				db.run(
					"INSERT INTO session_goals (session_id, payload) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload",
					[sessionId, JSON.stringify(tx.entry)],
				);
			} else {
				db.run("DELETE FROM session_goals WHERE session_id = ?", [sessionId]);
				db.run("DELETE FROM goal_continuations WHERE session_id = ?", [
					sessionId,
				]);
			}
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
