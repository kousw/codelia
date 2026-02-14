import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	SessionState,
	SessionStateStore,
	SessionStateSummary,
	StoragePaths,
} from "@codelia/core";
import { stringifyContent } from "@codelia/core";
import { resolveStoragePaths } from "./paths";

const LEGACY_STATE_DIRNAME = "state";
const MESSAGES_DIRNAME = "messages";
const STATE_DB_FILENAME = "state.db";

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
};

type SessionStateSummaryDbRow = {
	session_id: string;
	updated_at: string;
	run_id: string | null;
	message_count: number | null;
	last_user_message: string | null;
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
});

const fromSummaryRow = (
	row: SessionStateSummaryDbRow,
): SessionStateSummary => ({
	session_id: row.session_id,
	updated_at: row.updated_at,
	run_id: row.run_id ?? undefined,
	message_count: row.message_count ?? undefined,
	last_user_message: row.last_user_message ?? undefined,
});

const serializeMessages = (messages: SessionState["messages"]): string => {
	if (messages.length === 0) return "";
	return `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`;
};

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

const atomicWriteFile = async (
	filePath: string,
	payload: string,
): Promise<void> => {
	const dirname = path.dirname(filePath);
	const basename = path.basename(filePath);
	const tempFile = path.join(
		dirname,
		`${basename}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	let wroteTemp = false;
	try {
		await fs.writeFile(tempFile, payload, "utf8");
		wroteTemp = true;
		await fs.rename(tempFile, filePath);
	} catch (error) {
		if (wroteTemp) {
			await fs.rm(tempFile, { force: true }).catch(() => {});
		}
		throw error;
	}
};

type SessionStateStoreOptions = {
	paths?: StoragePaths;
	onError?: (
		error: unknown,
		context: { action: string; detail?: string },
	) => void;
};

export class SessionStateStoreImpl implements SessionStateStore {
	private readonly legacyStateDir: string;
	private readonly messagesDir: string;
	private readonly stateDbPath: string;
	private readonly ensureDirs: Promise<void>;
	private db: Promise<SqliteAdapter> | null;
	private schemaInit: Promise<void> | null;
	private readonly onError?: SessionStateStoreOptions["onError"];
	private lastDbUnavailableError: unknown;

	constructor(options: SessionStateStoreOptions = {}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.legacyStateDir = resolveLegacyStateDir(paths);
		this.messagesDir = resolveMessagesDir(paths);
		this.stateDbPath = resolveStateDbPath(paths);
		this.ensureDirs = Promise.all([
			fs.mkdir(paths.sessionsDir, { recursive: true }),
			fs.mkdir(this.legacyStateDir, { recursive: true }),
			fs.mkdir(this.messagesDir, { recursive: true }),
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
		return path.join(this.messagesDir, `${sessionId}.jsonl`);
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
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec(`
			CREATE TABLE IF NOT EXISTS session_state (
				session_id TEXT PRIMARY KEY,
				updated_at TEXT NOT NULL,
				run_id TEXT,
				invoke_seq INTEGER,
				schema_version INTEGER NOT NULL,
				meta_json TEXT,
				message_count INTEGER,
				last_user_message TEXT
			);
		`);
		db.exec(`
			CREATE INDEX IF NOT EXISTS idx_session_state_updated_at
			ON session_state(updated_at DESC);
		`);
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
				`SELECT session_id, updated_at, run_id, invoke_seq, schema_version, meta_json
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
			const payload = await fs.readFile(
				this.resolveMessagePath(sessionId),
				"utf8",
			);
			messages = deserializeMessages(payload);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
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
		const messagePayload = serializeMessages(
			Array.isArray(state.messages) ? state.messages : [],
		);
		await atomicWriteFile(
			this.resolveMessagePath(state.session_id),
			messagePayload,
		);

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
				last_user_message
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				updated_at = excluded.updated_at,
				run_id = excluded.run_id,
				invoke_seq = excluded.invoke_seq,
				schema_version = excluded.schema_version,
				meta_json = excluded.meta_json,
				message_count = excluded.message_count,
				last_user_message = excluded.last_user_message`,
			[
				state.session_id,
				state.updated_at,
				state.run_id ?? null,
				state.invoke_seq ?? null,
				state.schema_version ?? 1,
				state.meta ? JSON.stringify(state.meta) : null,
				summary.message_count ?? null,
				summary.last_user_message ?? null,
			],
		);
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
				`SELECT session_id, updated_at, run_id, message_count, last_user_message
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
