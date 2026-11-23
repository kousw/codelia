import { mkdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LOCK_TIMEOUT_MS = 5_000;
const queues = new Map<string, Promise<void>>();

const canonicalConfigPath = async (
	configPath: string,
	remainingLinks = 40,
): Promise<string> => {
	const absolute = path.resolve(configPath);
	try {
		return await realpath(absolute);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// realpath cannot follow a symlink whose target has not been created yet.
	let link: string;
	try {
		link = await readlink(absolute);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EINVAL") throw error;
		const parent = path.dirname(absolute);
		await mkdir(parent, { recursive: true });
		return path.join(await realpath(parent), path.basename(absolute));
	}
	if (remainingLinks === 0) {
		throw new Error(`Too many symlinks for config file: ${configPath}`);
	}
	return canonicalConfigPath(
		path.resolve(path.dirname(absolute), link),
		remainingLinks - 1,
	);
};

const withProcessLock = async <T>(
	file: string,
	fn: () => Promise<T>,
): Promise<T> => {
	const { openSqlite } = await import("@codelia/storage");
	// Keep the lock file's inode stable. SQLite releases the lock on close or crash.
	const db = await openSqlite(`${file}.lock.sqlite`);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		const deadline = performance.now() + LOCK_TIMEOUT_MS;
		for (;;) {
			try {
				db.exec("BEGIN IMMEDIATE");
				break;
			} catch (error) {
				const code = (error as { code?: string } | null)?.code;
				if (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED") throw error;
				if (performance.now() >= deadline) {
					throw new Error(`Timed out locking config file: ${file}`);
				}
				await delay(20);
			}
		}
		return await fn();
	} finally {
		// The transaction only acquires the lock; closing rolls it back.
		db.close();
	}
};

export const withConfigFileLock = async <T>(
	configPath: string,
	fn: (lockedPath: string) => Promise<T>,
): Promise<T> => {
	const key = await canonicalConfigPath(configPath);
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(() => withProcessLock(key, () => fn(key)));
	const settled = next.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, settled);
	try {
		return await next;
	} finally {
		if (queues.get(key) === settled) queues.delete(key);
	}
};
