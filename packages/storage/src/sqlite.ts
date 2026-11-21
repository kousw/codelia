export type SqliteAdapter = {
	exec: (sql: string) => void;
	close: () => void;
	run: (sql: string, params?: unknown[]) => void;
	get: <T>(sql: string, params?: unknown[]) => T | undefined;
	all: <T>(sql: string, params?: unknown[]) => T[];
};

export const openSqlite = async (filename: string): Promise<SqliteAdapter> => {
	if (process.versions.bun) {
		type BunSqliteDatabase = {
			exec: (sql: string) => void;
			close: () => void;
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
		const db = new Database(filename, { create: true });
		return {
			close: () => db.close(),
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
		close: () => void;
		prepare: (sql: string) => BetterSqliteStatement;
	};
	type BetterSqliteConstructor = new (filename: string) => BetterSqliteDatabase;
	const betterSqliteSpecifier = "better-sqlite3";
	const betterSqliteModule = (await import(betterSqliteSpecifier)) as {
		default?: unknown;
	};
	const BetterSqlite3 = (betterSqliteModule.default ??
		betterSqliteModule) as BetterSqliteConstructor;
	const db = new BetterSqlite3(filename);
	return {
		close: () => db.close(),
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
};
