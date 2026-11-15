import {
	closeSync,
	type Dirent,
	existsSync,
	promises as fs,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
	SessionState,
	SessionStateStore,
	SessionStateSummary,
	StoragePaths,
} from "@codelia/core";
import { stringifyContent } from "@codelia/core";
import {
	appendOriginalMessages,
	readOriginalMessage,
	searchOriginalMessages,
} from "./conversation-archive";
import { resolveStoragePaths } from "./paths";
import { validateRunLogId } from "./run-log-paths";
import {
	type SessionRunEntry,
	type SessionRunRecorder,
	scanSessionRunLogs,
} from "./session-run-index";

const LEGACY_STATE_DIRNAME = "state";
const MESSAGES_DIRNAME = "messages";
const STATE_DB_FILENAME = "state.db";
const SESSION_WORKSPACE_ROOT_META_KEY = "codelia_workspace_root";
/** storage_meta key set once a store-wide header scan has filled session_runs. */
const RUN_INDEX_BACKFILL_KEY = "session_runs_backfilled_at";

const resolveLegacyStateDir = (paths: StoragePaths): string =>
	path.join(paths.sessionsDir, LEGACY_STATE_DIRNAME);

const resolveMessagesDir = (paths: StoragePaths): string =>
	path.join(paths.sessionsDir, MESSAGES_DIRNAME);

const resolveStateDbPath = (paths: StoragePaths): string =>
	path.join(paths.sessionsDir, STATE_DB_FILENAME);

type SessionMessage = SessionState["messages"][number];

type SessionStateDbRow = {
	session_id: string;
	updated_at: string;
	run_id: string | null;
	invoke_seq: number | null;
	schema_version: number;
	meta_json: string | null;
	archive_version: number;
};

type SessionStateSummaryDbRow = {
	session_id: string;
	updated_at: string;
	run_id: string | null;
	message_count: number | null;
	last_user_message: string | null;
	workspace_root: string | null;
	pinned: number;
	archived_at: string | null;
};

type SqliteTableInfoRow = {
	name?: string;
};

type SqliteAdapter = {
	exec: (sql: string) => void;
	run: (sql: string, params?: unknown[]) => void;
	get: <T>(sql: string, params?: unknown[]) => T | undefined;
	all: <T>(sql: string, params?: unknown[]) => T[];
};

const extractLastUserMessage = (
	messages: SessionState["messages"],
): string | undefined => {
	for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
		const message = messages[idx] as SessionMessage | undefined;
		if (!message || typeof message !== "object") continue;
		if ("role" in message && message.role === "user" && "content" in message) {
			return stringifyContent(message.content as SessionMessage["content"], {
				mode: "display",
			});
		}
	}
	return undefined;
};

const extractWorkspaceRoot = (
	meta: SessionState["meta"],
): string | undefined => {
	const raw = meta?.[SESSION_WORKSPACE_ROOT_META_KEY];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length ? trimmed : undefined;
};

const toSummary = (state: SessionState): SessionStateSummary => ({
	session_id: state.session_id,
	updated_at: state.updated_at,
	run_id: state.run_id,
	message_count: Array.isArray(state.messages)
		? state.messages.length
		: undefined,
	last_user_message: Array.isArray(state.messages)
		? extractLastUserMessage(state.messages)
		: undefined,
	workspace_root: extractWorkspaceRoot(state.meta),
});

const fromSummaryRow = (
	row: SessionStateSummaryDbRow,
): SessionStateSummary => ({
	session_id: row.session_id,
	updated_at: row.updated_at,
	run_id: row.run_id ?? undefined,
	message_count: row.message_count ?? undefined,
	last_user_message: row.last_user_message ?? undefined,
	workspace_root: row.workspace_root ?? undefined,
	...(row.pinned === 1 ? { pinned: true } : {}),
	...(row.archived_at ? { archived_at: row.archived_at } : {}),
});

const deserializeMessages = (payload: string): SessionState["messages"] => {
	if (!payload.trim()) return [];
	const messages: SessionState["messages"] = [];
	const lines = payload.split(/\r?\n/);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const parsed = JSON.parse(line) as SessionMessage;
		if (!parsed || typeof parsed !== "object") {
			throw new Error("Invalid session message entry");
		}
		messages.push(parsed);
	}
	return messages;
};

type SessionStateStoreOptions = {
	paths?: StoragePaths;
	onError?: (
		error: unknown,
		context: { action: string; detail?: string },
	) => void;
};

export class SessionStateStoreImpl
	implements SessionStateStore, SessionRunRecorder
{
	/** Root that `session_runs.rel_path` values are relative to. */
	readonly sessionsDir: string;
	private readonly legacyStateDir: string;
	private readonly messagesDir: string;
	private readonly contextsDir: string;
	private readonly stateDbPath: string;
	private readonly ensureDirs: Promise<void>;
	private db: Promise<SqliteAdapter> | null;
	private schemaInit: Promise<void> | null;
	private readonly onError?: SessionStateStoreOptions["onError"];
	private lastDbUnavailableError: unknown;
	private runIndexBackfill: Promise<void> | null = null;

	constructor(options: SessionStateStoreOptions = {}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.sessionsDir = paths.sessionsDir;
		this.legacyStateDir = resolveLegacyStateDir(paths);
		this.messagesDir = resolveMessagesDir(paths);
		this.contextsDir = path.join(paths.sessionsDir, "contexts");
		this.stateDbPath = resolveStateDbPath(paths);
		this.ensureDirs = Promise.all([
			fs.mkdir(paths.sessionsDir, { recursive: true }),
			fs.mkdir(this.legacyStateDir, { recursive: true }),
			fs.mkdir(this.messagesDir, { recursive: true }),
			fs.mkdir(this.contextsDir, { recursive: true }),
		]).then(() => {});
		this.onError = options.onError;
		this.db = null;
		this.schemaInit = null;
		this.lastDbUnavailableError = null;
	}

	private getOrCreateDb(): Promise<SqliteAdapter> {
		if (!this.db) {
			this.db = this.openDatabase();
		}
		return this.db;
	}

	private resolveLegacyPath(sessionId: string): string {
		return path.join(this.legacyStateDir, `${sessionId}.json`);
	}

	private resolveMessagePath(sessionId: string): string {
		return path.join(this.messagesDir, `${validateRunLogId(sessionId)}.jsonl`);
	}

	private contextPath(sessionId: string): string {
		return path.join(this.contextsDir, `${validateRunLogId(sessionId)}.json`);
	}

	private writeContext(
		sessionId: string,
		messages: SessionState["messages"],
	): void {
		const target = this.contextPath(sessionId);
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		const archiveBytes = lstatSync(this.resolveMessagePath(sessionId)).size;
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(
					fd,
					JSON.stringify({ version: 1, archive_bytes: archiveBytes, messages }),
				);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, target);
		} finally {
			if (existsSync(temporary)) unlinkSync(temporary);
		}
	}

	private ensureArchive(sessionId: string, db: SqliteAdapter): boolean {
		const row = db.get<{ archive_version: number }>(
			"SELECT archive_version FROM session_state WHERE session_id = ?",
			[sessionId],
		);
		if (row?.archive_version === 1) {
			if (!lstatSync(this.resolveMessagePath(sessionId)).isFile())
				throw new Error("Invalid original conversation archive");
			return false;
		}
		const file = this.resolveMessagePath(sessionId);
		let messages: SessionState["messages"] = [];
		if (existsSync(file)) {
			if (!lstatSync(file).isFile())
				throw new Error("Invalid legacy conversation file");
			messages = deserializeMessages(readFileSync(file, "utf8"));
		} else appendOriginalMessages(file, []);
		this.writeContext(sessionId, messages);
		db.run(
			`INSERT INTO session_state (session_id, updated_at, schema_version, archive_version) VALUES (?, ?, 1, 1)
			ON CONFLICT(session_id) DO UPDATE SET archive_version = 1`,
			[sessionId, new Date().toISOString()],
		);
		return messages.length === 0;
	}

	private async openDatabase(): Promise<SqliteAdapter> {
		await this.ensureDirs;

		if (process.versions.bun) {
			type BunSqliteDatabase = {
				exec: (sql: string) => void;
				query: (sql: string) => {
					run: (...params: unknown[]) => unknown;
					get: (...params: unknown[]) => unknown;
					all: (...params: unknown[]) => unknown[];
				};
			};
			const bunSqliteSpecifier = "bun:sqlite";
			const { Database } = (await import(bunSqliteSpecifier)) as {
				Database: new (
					filename: string,
					options?: { create?: boolean },
				) => BunSqliteDatabase;
			};
			const db = new Database(this.stateDbPath, { create: true });
			return {
				exec: (sql: string) => {
					db.exec(sql);
				},
				run: (sql: string, params: unknown[] = []) => {
					db.query(sql).run(...params);
				},
				get: <T>(sql: string, params: unknown[] = []): T | undefined => {
					const row = db.query(sql).get(...params) as T | null;
					return row ?? undefined;
				},
				all: <T>(sql: string, params: unknown[] = []): T[] =>
					db.query(sql).all(...params) as T[],
			};
		}

		type BetterSqliteStatement = {
			run: (...params: unknown[]) => unknown;
			get: (...params: unknown[]) => unknown;
			all: (...params: unknown[]) => unknown[];
		};
		type BetterSqliteDatabase = {
			exec: (sql: string) => unknown;
			prepare: (sql: string) => BetterSqliteStatement;
		};
		type BetterSqliteConstructor = new (
			filename: string,
		) => BetterSqliteDatabase;
		const betterSqliteSpecifier = "better-sqlite3";
		const betterSqliteModule = (await import(betterSqliteSpecifier)) as {
			default?: unknown;
		};
		const BetterSqlite3 = (betterSqliteModule.default ??
			betterSqliteModule) as BetterSqliteConstructor;
		const db = new BetterSqlite3(this.stateDbPath);
		return {
			exec: (sql: string) => {
				db.exec(sql);
			},
			run: (sql: string, params: unknown[] = []) => {
				db.prepare(sql).run(...params);
			},
			get: <T>(sql: string, params: unknown[] = []): T | undefined => {
				const row = db.prepare(sql).get(...params) as T | null;
				return row ?? undefined;
			},
			all: <T>(sql: string, params: unknown[] = []): T[] =>
				db.prepare(sql).all(...params) as T[],
		};
	}

	private initDatabaseSchema(db: SqliteAdapter): void {
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_state (
					session_id TEXT PRIMARY KEY,
					updated_at TEXT NOT NULL,
					run_id TEXT,
					invoke_seq INTEGER,
					schema_version INTEGER NOT NULL,
					meta_json TEXT,
					message_count INTEGER,
					last_user_message TEXT,
					workspace_root TEXT
				);
			`);
			const columns = db.all<SqliteTableInfoRow>(
				"PRAGMA table_info(session_state)",
			);
			const columnNames = new Set(
				columns
					.map((column) => column.name)
					.filter((name): name is string => typeof name === "string"),
			);
			if (!columnNames.has("workspace_root")) {
				db.exec("ALTER TABLE session_state ADD COLUMN workspace_root TEXT;");
			}
			if (!columnNames.has("pinned"))
				db.exec(
					"ALTER TABLE session_state ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
				);
			if (!columnNames.has("archived_at"))
				db.exec("ALTER TABLE session_state ADD COLUMN archived_at TEXT;");
			if (!columnNames.has("archive_version"))
				db.exec(
					"ALTER TABLE session_state ADD COLUMN archive_version INTEGER NOT NULL DEFAULT 0;",
				);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_session_state_updated_at
				ON session_state(updated_at DESC);
			`);
			// One row per run log; written when the run header is appended.
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_runs (
					rel_path TEXT PRIMARY KEY,
					session_id TEXT NOT NULL,
					run_id TEXT NOT NULL,
					started_at TEXT NOT NULL
				);
			`);
			db.exec(`
				CREATE INDEX IF NOT EXISTS idx_session_runs_session
				ON session_runs(session_id, started_at DESC);
			`);
			// Latest run_id already rescanned without finding its log.
			db.exec(`
				CREATE TABLE IF NOT EXISTS session_run_checks (
					session_id TEXT PRIMARY KEY,
					run_id TEXT NOT NULL,
					checked_at TEXT NOT NULL
				);
			`);
			db.exec(`
				CREATE TABLE IF NOT EXISTS storage_meta (
					key TEXT PRIMARY KEY,
					value TEXT NOT NULL
				);
			`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	private async tryGetDb(
		action: string,
		detail?: string,
	): Promise<SqliteAdapter | null> {
		try {
			const db = await this.getOrCreateDb();
			if (!this.schemaInit) {
				this.schemaInit = Promise.resolve().then(() => {
					this.initDatabaseSchema(db);
				});
			}
			await this.schemaInit;
			this.lastDbUnavailableError = null;
			return db;
		} catch (error) {
			this.db = null;
			this.schemaInit = null;
			this.lastDbUnavailableError = error;
			this.onError?.(error, { action: `${action}.db_unavailable`, detail });
			return null;
		}
	}

	private async requireDb(
		action: string,
		detail?: string,
	): Promise<SqliteAdapter> {
		const db = await this.tryGetDb(action, detail);
		if (!db) {
			const reason = this.lastDbUnavailableError
				? `: ${String(this.lastDbUnavailableError)}`
				: "";
			throw new Error(`Session index database unavailable${reason}`);
		}
		return db;
	}

	private async loadLegacy(sessionId: string): Promise<SessionState | null> {
		try {
			const file = await fs.readFile(this.resolveLegacyPath(sessionId), "utf8");
			const parsed = JSON.parse(file) as SessionState;
			if (!parsed || typeof parsed !== "object") return null;
			if (!parsed.session_id || !parsed.updated_at) return null;
			const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
			return {
				schema_version:
					typeof parsed.schema_version === "number" ? parsed.schema_version : 1,
				session_id: parsed.session_id,
				updated_at: parsed.updated_at,
				run_id: parsed.run_id,
				invoke_seq: parsed.invoke_seq,
				messages,
				meta:
					parsed.meta && typeof parsed.meta === "object"
						? parsed.meta
						: undefined,
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return null;
			}
			this.onError?.(error, { action: "legacy.load", detail: sessionId });
			throw error;
		}
	}

	private async loadFromIndex(
		sessionId: string,
		db: SqliteAdapter,
	): Promise<SessionState | null> {
		let row: SessionStateDbRow | undefined;
		try {
			row = db.get<SessionStateDbRow>(
				`SELECT session_id, updated_at, run_id, invoke_seq, schema_version, meta_json, archive_version
				 FROM session_state
				 WHERE session_id = ?`,
				[sessionId],
			);
		} catch (error) {
			this.onError?.(error, { action: "index.load", detail: sessionId });
			throw error;
		}
		if (!row) return null;

		let messages: SessionState["messages"];
		try {
			if (row.archive_version === 1) {
				const checkpoint = JSON.parse(
					await fs.readFile(this.contextPath(sessionId), "utf8"),
				);
				if (checkpoint.version !== 1 || !Array.isArray(checkpoint.messages))
					throw new Error("Invalid active conversation checkpoint");
				messages = checkpoint.messages;
			} else
				messages = deserializeMessages(
					await fs.readFile(this.resolveMessagePath(sessionId), "utf8"),
				);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code === "ENOENT" &&
				row.archive_version !== 1
			) {
				messages = [];
			} else {
				this.onError?.(error, { action: "messages.load", detail: sessionId });
				throw error;
			}
		}

		let meta: Record<string, unknown> | undefined;
		if (row.meta_json) {
			try {
				const parsed = JSON.parse(row.meta_json) as Record<string, unknown>;
				if (parsed && typeof parsed === "object") {
					meta = parsed;
				}
			} catch (error) {
				this.onError?.(error, {
					action: "index.meta.parse",
					detail: sessionId,
				});
			}
		}

		return {
			schema_version: 1,
			session_id: row.session_id,
			updated_at: row.updated_at,
			run_id: row.run_id ?? undefined,
			invoke_seq: row.invoke_seq ?? undefined,
			messages,
			meta,
		};
	}

	private async saveToIndex(
		state: SessionState,
		db: SqliteAdapter,
	): Promise<void> {
		await this.withRetentionGuard(state.session_id, () => {
			const seed = this.ensureArchive(state.session_id, db);
			if (seed)
				appendOriginalMessages(
					this.resolveMessagePath(state.session_id),
					state.messages,
				);
			this.writeContext(state.session_id, state.messages);
			const summary = toSummary(state);
			db.run(
				`INSERT INTO session_state (
				session_id,
				updated_at,
				run_id,
				invoke_seq,
				schema_version,
				meta_json,
				message_count,
				last_user_message,
				workspace_root
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				updated_at = excluded.updated_at,
				run_id = excluded.run_id,
				invoke_seq = excluded.invoke_seq,
				schema_version = excluded.schema_version,
				meta_json = excluded.meta_json,
				message_count = excluded.message_count,
				last_user_message = excluded.last_user_message,
				workspace_root = excluded.workspace_root`,
				[
					state.session_id,
					state.updated_at,
					state.run_id ?? null,
					state.invoke_seq ?? null,
					state.schema_version ?? 1,
					state.meta ? JSON.stringify(state.meta) : null,
					summary.message_count ?? null,
					summary.last_user_message ?? null,
					summary.workspace_root ?? null,
				],
			);
		});
	}

	async appendMessages(
		sessionId: string,
		messages: SessionState["messages"],
	): Promise<void> {
		const db = await this.requireDb("archive.append", sessionId);
		// A state/<id>.json-only session must migrate its available originals and
		// metadata before an append can establish a new archive-version row.
		if (!(await this.getSummary(sessionId))) await this.load(sessionId);
		await this.withRetentionGuard(sessionId, () => {
			this.ensureArchive(sessionId, db);
			appendOriginalMessages(this.resolveMessagePath(sessionId), messages);
		});
	}

	async searchMessages(
		sessionId: string,
		options: Parameters<typeof searchOriginalMessages>[1],
	) {
		if (!(await this.getSummary(sessionId))) await this.load(sessionId);
		return searchOriginalMessages(this.resolveMessagePath(sessionId), options);
	}

	async readMessage(
		sessionId: string,
		options: Parameters<typeof readOriginalMessage>[1],
	) {
		if (!(await this.getSummary(sessionId))) await this.load(sessionId);
		return readOriginalMessage(this.resolveMessagePath(sessionId), options);
	}

	async load(sessionId: string): Promise<SessionState | null> {
		const db = await this.requireDb("load", sessionId);
		try {
			const indexed = await this.loadFromIndex(sessionId, db);
			if (indexed) return indexed;
		} catch (error) {
			this.onError?.(error, { action: "load.index", detail: sessionId });
			throw error;
		}

		const legacy = await this.loadLegacy(sessionId);
		if (!legacy) return null;

		if (db) {
			try {
				await this.saveToIndex(legacy, db);
			} catch (error) {
				this.onError?.(error, {
					action: "load.migrate_legacy",
					detail: sessionId,
				});
				throw error;
			}
		}
		return legacy;
	}

	async save(state: SessionState): Promise<void> {
		await this.ensureDirs;
		const db = await this.requireDb("save", state.session_id);

		try {
			await this.saveToIndex(state, db);
		} catch (error) {
			this.onError?.(error, { action: "save.index", detail: state.session_id });
			throw error;
		}
	}

	async getSummary(sessionId: string): Promise<SessionStateSummary | null> {
		const db = await this.requireDb("summary", sessionId);
		const row = db.get<SessionStateSummaryDbRow>(
			"SELECT session_id, updated_at, run_id, message_count, last_user_message, workspace_root, pinned, archived_at FROM session_state WHERE session_id = ?",
			[sessionId],
		);
		return row ? fromSummaryRow(row) : null;
	}

	/** Serializes pin changes with the final, synchronous unlink decision. */
	async withRetentionGuard<T>(
		sessionId: string,
		action: (summary: SessionStateSummary | null) => T,
	): Promise<T> {
		const db = await this.requireDb("retention", sessionId);
		db.exec("BEGIN IMMEDIATE");
		try {
			const row = db.get<SessionStateSummaryDbRow>(
				"SELECT session_id, updated_at, run_id, message_count, last_user_message, workspace_root, pinned, archived_at FROM session_state WHERE session_id = ?",
				[sessionId],
			);
			const result = action(row ? fromSummaryRow(row) : null);
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	async updateMetadata(
		sessionId: string,
		patch: { pinned?: boolean; archived?: boolean },
	): Promise<SessionStateSummary> {
		if (!(await this.getSummary(sessionId))) await this.load(sessionId);
		const db = await this.requireDb("updateMetadata", sessionId);
		return this.withRetentionGuard(sessionId, (summary) => {
			if (!summary) throw new Error("Session not found");
			if (patch.pinned !== undefined)
				db.run("UPDATE session_state SET pinned = ? WHERE session_id = ?", [
					patch.pinned ? 1 : 0,
					sessionId,
				]);
			const archivedAt =
				patch.archived === undefined
					? summary.archived_at
					: patch.archived
						? (summary.archived_at ?? new Date().toISOString())
						: undefined;
			if (patch.archived !== undefined)
				db.run(
					"UPDATE session_state SET archived_at = ? WHERE session_id = ?",
					[archivedAt ?? null, sessionId],
				);
			return {
				...summary,
				pinned: patch.pinned ?? summary.pinned,
				archived_at: archivedAt,
			};
		});
	}

	/** Records a run log; idempotent, safe across concurrent runtimes. */
	async recordSessionRun(entry: SessionRunEntry): Promise<void> {
		const db = await this.requireDb("runs.record", entry.session_id);
		db.run(
			`INSERT INTO session_runs (rel_path, session_id, run_id, started_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(rel_path) DO NOTHING`,
			[entry.rel_path, entry.session_id, entry.run_id, entry.started_at],
		);
	}

	/**
	 * The index answers for a session once a store-wide backfill finished and
	 * the session's latest run_id is either indexed or was already rescanned.
	 * The run_id check catches logs written by runtimes that predate the index.
	 */
	private isSessionRunIndexComplete(
		db: SqliteAdapter,
		sessionId: string,
	): boolean {
		if (
			!db.get("SELECT 1 AS ok FROM storage_meta WHERE key = ?", [
				RUN_INDEX_BACKFILL_KEY,
			])
		)
			return false;
		const latest = db.get<{ run_id: string | null }>(
			"SELECT run_id FROM session_state WHERE session_id = ?",
			[sessionId],
		)?.run_id;
		if (!latest) return true;
		return Boolean(
			db.get(
				"SELECT 1 AS ok FROM session_runs WHERE session_id = ? AND run_id = ? LIMIT 1",
				[sessionId, latest],
			) ??
				db.get(
					"SELECT 1 AS ok FROM session_run_checks WHERE session_id = ? AND run_id = ?",
					[sessionId, latest],
				),
		);
	}

	/** One store-wide header scan per process at a time; rows are idempotent. */
	private backfillSessionRuns(db: SqliteAdapter): Promise<void> {
		if (!this.runIndexBackfill) {
			this.runIndexBackfill = (async () => {
				const entries = await scanSessionRunLogs(this.sessionsDir);
				db.exec("BEGIN IMMEDIATE");
				try {
					for (const entry of entries)
						db.run(
							`INSERT INTO session_runs (rel_path, session_id, run_id, started_at)
							VALUES (?, ?, ?, ?)
							ON CONFLICT(rel_path) DO NOTHING`,
							[
								entry.rel_path,
								entry.session_id,
								entry.run_id,
								entry.started_at,
							],
						);
					db.run(
						`INSERT INTO storage_meta (key, value) VALUES (?, ?)
						ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
						[RUN_INDEX_BACKFILL_KEY, new Date().toISOString()],
					);
					db.exec("COMMIT");
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			})().finally(() => {
				this.runIndexBackfill = null;
			});
		}
		return this.runIndexBackfill;
	}

	/**
	 * Returns the session's run logs, newest first. Falls back to one
	 * store-wide header scan (which indexes every session) only while the
	 * index cannot answer for this session.
	 */
	async listSessionRuns(sessionId: string): Promise<SessionRunEntry[]> {
		const db = await this.requireDb("runs.list", sessionId);
		if (!this.isSessionRunIndexComplete(db, sessionId)) {
			const latest = db.get<{ run_id: string | null }>(
				"SELECT run_id FROM session_state WHERE session_id = ?",
				[sessionId],
			)?.run_id;
			await this.backfillSessionRuns(db);
			if (latest)
				db.run(
					`INSERT INTO session_run_checks (session_id, run_id, checked_at)
					VALUES (?, ?, ?)
					ON CONFLICT(session_id) DO UPDATE SET
						run_id = excluded.run_id,
						checked_at = excluded.checked_at`,
					[sessionId, latest, new Date().toISOString()],
				);
		}
		return db.all<SessionRunEntry>(
			`SELECT session_id, run_id, rel_path, started_at
			FROM session_runs
			WHERE session_id = ?
			ORDER BY started_at DESC, rel_path DESC`,
			[sessionId],
		);
	}

	private async listLegacySummaries(): Promise<SessionStateSummary[]> {
		let entries: Dirent[];
		try {
			entries = (await fs.readdir(this.legacyStateDir, {
				withFileTypes: true,
				encoding: "utf8",
			})) as Dirent[];
		} catch (error) {
			this.onError?.(error, { action: "legacy.list" });
			throw error;
		}
		const summaries: SessionStateSummary[] = [];
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".json")) continue;
			const filePath = path.join(this.legacyStateDir, entry.name);
			try {
				const contents = await fs.readFile(filePath, "utf8");
				const parsed = JSON.parse(contents) as SessionState;
				if (!parsed || typeof parsed !== "object") continue;
				if (!parsed.session_id || !parsed.updated_at) continue;
				summaries.push(
					toSummary({
						...parsed,
						schema_version:
							typeof parsed.schema_version === "number"
								? parsed.schema_version
								: 1,
						messages: Array.isArray(parsed.messages) ? parsed.messages : [],
					}),
				);
			} catch (error) {
				this.onError?.(error, { action: "legacy.parse", detail: filePath });
			}
		}
		return summaries;
	}

	async list(): Promise<SessionStateSummary[]> {
		await this.ensureDirs;
		const summaries = new Map<string, SessionStateSummary>();

		const db = await this.requireDb("list");
		try {
			const rows = db.all<SessionStateSummaryDbRow>(
				`SELECT session_id, updated_at, run_id, message_count, last_user_message, workspace_root, pinned, archived_at
				 FROM session_state
				 ORDER BY updated_at DESC`,
			);
			for (const row of rows) {
				summaries.set(row.session_id, fromSummaryRow(row));
			}
		} catch (error) {
			this.onError?.(error, { action: "list.index" });
			throw error;
		}

		const legacy = await this.listLegacySummaries();
		for (const item of legacy) {
			if (!summaries.has(item.session_id)) {
				summaries.set(item.session_id, item);
			}
		}

		return [...summaries.values()];
	}
}
