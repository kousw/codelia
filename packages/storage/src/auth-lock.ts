import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openSqlite, type SqliteAdapter } from "./sqlite";
import {
	ensureCredentialsDirectory,
	verifyWindowsCredentialFileAcl,
} from "./windows-acl";

/** Bounded timeout for OAuth token refresh HTTP requests (spec §9.5). */
export const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 30_000;

/**
 * Interprocess lock wait deadline for credential stores (spec §9.5).
 * Deliberately longer than DEFAULT_OAUTH_REFRESH_TIMEOUT_MS (and separate from
 * ProjectsPolicyStore's 1s lock) so sibling processes wait for an in-flight
 * token rotation instead of double-consuming a single-use refresh token.
 */
export const DEFAULT_AUTH_LOCK_TIMEOUT_MS = 35_000;

const DEFAULT_POLL_MS = 25;

/** In-process serialization per lock path so intra-process callers queue cleanly. */
const inProcessQueues = new Map<string, Promise<void>>();

export const authLockPathFor = (dir: string): string =>
	path.join(dir, ".auth-store-lock.sqlite");

const isMissing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException)?.code === "ENOENT";

const lstatIfPresent = (file: string) =>
	fs.lstat(file).catch((error: unknown) => {
		if (!isMissing(error)) throw error;
		return undefined;
	});

const verifyLockFile = async (file: string): Promise<void> => {
	const info = await lstatIfPresent(file);
	if (!info) return;
	const uid = process.geteuid?.();
	if (
		!info.isFile() ||
		info.size === 0 ||
		(uid !== undefined && (info.uid !== uid || (info.mode & 0o022) !== 0))
	) {
		throw new Error("unsafe_auth_store_lock");
	}
};

const initializeLockFile = async (lockPath: string): Promise<void> => {
	if (await lstatIfPresent(lockPath)) return;
	const temporary = `${lockPath}.${randomUUID()}.tmp`;
	try {
		const file = await fs.open(temporary, "wx", 0o600);
		await file.close();
		const db = await openSqlite(temporary);
		try {
			// Reserve an actual SQLite database header on disk.
			db.exec("PRAGMA user_version = 1");
		} finally {
			db.close();
		}
		try {
			await fs.link(temporary, lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await fs.unlink(temporary).catch(() => undefined);
	}
};

const isSqliteBusy = (error: unknown): boolean => {
	const code = (error as { code?: unknown })?.code;
	if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /database is locked|SQLITE_BUSY/i.test(message);
};

const openAuthLock = async (
	lockPath: string,
	timeoutMs: number,
	pollMs: number,
): Promise<SqliteAdapter> => {
	await ensureCredentialsDirectory(path.dirname(lockPath));
	await initializeLockFile(lockPath);
	await verifyLockFile(lockPath);
	if (process.platform === "win32") {
		if (!(await verifyWindowsCredentialFileAcl(lockPath))) {
			throw new Error("unsafe_auth_store_lock");
		}
		await Promise.all(
			["-journal", "-wal", "-shm"].map((suffix) =>
				verifyWindowsCredentialFileAcl(lockPath + suffix),
			),
		);
	}
	const db = await openSqlite(lockPath);
	const deadline = performance.now() + timeoutMs;
	try {
		db.exec("PRAGMA busy_timeout = 0");
		for (;;) {
			try {
				db.exec("BEGIN IMMEDIATE");
				return db;
			} catch (error) {
				if (!isSqliteBusy(error) || performance.now() >= deadline) {
					throw error;
				}
				await delay(pollMs);
			}
		}
	} catch (error) {
		db.close();
		throw error;
	}
};

const enqueueInProcess = async <T>(
	key: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const previous = inProcessQueues.get(key) ?? Promise.resolve();
	const next = previous.then(fn, fn);
	const settled = next.then(
		() => undefined,
		() => undefined,
	);
	inProcessQueues.set(key, settled);
	try {
		return await next;
	} finally {
		if (inProcessQueues.get(key) === settled) inProcessQueues.delete(key);
	}
};

export type AuthLockOptions = {
	timeoutMs?: number;
	pollMs?: number;
};

/**
 * Run `fn` while holding both an in-process queue slot and an interprocess
 * SQLite `BEGIN IMMEDIATE` lock at `lockPath`.
 */
export const withAuthStoreLock = <T>(
	lockPath: string,
	fn: () => Promise<T>,
	options: AuthLockOptions = {},
): Promise<T> => {
	const resolved = path.resolve(lockPath);
	const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_LOCK_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	return enqueueInProcess(resolved, async () => {
		const db = await openAuthLock(resolved, timeoutMs, pollMs);
		try {
			return await fn();
		} finally {
			try {
				db.exec("ROLLBACK");
			} catch {
				// Ignore rollback errors if no transaction is active.
			}
			db.close();
		}
	});
};
