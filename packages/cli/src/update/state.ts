import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isValidUpdateChannel } from "@codelia/config-loader";
import { openSqlite } from "@codelia/storage";
import { isValidVersion } from "./semver";

export type UpdatePaths = {
	dir: string;
	stateFile: string;
	noticesDir: string;
};

export const resolveUpdatePaths = (cacheDir: string): UpdatePaths => {
	const dir = path.join(cacheDir, "update");
	return {
		dir,
		stateFile: path.join(dir, "state.json"),
		noticesDir: path.join(dir, "notices"),
	};
};

/**
 * Lock file located directly inside the target installation's `node_modules/`
 * directory (independent of both `XDG_CACHE_HOME` and `TMPDIR`) so every
 * process updating the same global installation shares the exact same lock.
 */
export const resolveInstallApplyLockFile = (
	canonicalPackageRoot: string,
): string =>
	path.join(
		path.dirname(path.dirname(canonicalPackageRoot)),
		".codelia-update.lock.sqlite",
	);

export type UpdateState = {
	version: 1;
	last_check_at?: string;
	last_check_ok?: boolean;
	last_check_error?: string;
	channel?: string;
	/** SHA-256 of the normalized registry URL. */
	registry_id?: string;
	/** null selects automatic dist-tag inference. */
	configured_channel?: string | null;
	latest_version?: string;
	/** Running version that performed the last successful check. */
	checked_version?: string;
	apply_failure?: {
		version: string;
		at: string;
		message: string;
		unmanaged?: true;
	};
	applied?: { from: string; to: string; at: string };
};

const MAX_STATE_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is string =>
	typeof value === "string" &&
	value.length <= 64 &&
	Number.isFinite(Date.parse(value));

export const clampMessage = (value: string): string => {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal control bytes from stored messages
	const singleLine = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return singleLine.length > MAX_MESSAGE_LENGTH
		? `${singleLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
		: singleLine;
};

/** Keeps only validated fields; anything else is dropped as cache noise. */
export const parseUpdateState = (value: unknown): UpdateState => {
	const state: UpdateState = { version: 1 };
	if (!isRecord(value) || value.version !== 1) return state;
	if (isTimestamp(value.last_check_at)) {
		state.last_check_at = value.last_check_at;
	}
	if (typeof value.last_check_ok === "boolean") {
		state.last_check_ok = value.last_check_ok;
	}
	if (typeof value.last_check_error === "string") {
		state.last_check_error = clampMessage(value.last_check_error);
	}
	if (
		typeof value.channel === "string" &&
		isValidUpdateChannel(value.channel)
	) {
		state.channel = value.channel;
	}
	if (
		typeof value.registry_id === "string" &&
		/^[0-9a-f]{64}$/.test(value.registry_id)
	) {
		state.registry_id = value.registry_id;
	}
	if (
		value.configured_channel === null ||
		(typeof value.configured_channel === "string" &&
			isValidUpdateChannel(value.configured_channel))
	) {
		state.configured_channel = value.configured_channel;
	}
	if (isValidVersion(value.latest_version)) {
		state.latest_version = value.latest_version;
	}
	if (isValidVersion(value.checked_version)) {
		state.checked_version = value.checked_version;
	}
	if (
		isRecord(value.apply_failure) &&
		isValidVersion(value.apply_failure.version) &&
		isTimestamp(value.apply_failure.at) &&
		typeof value.apply_failure.message === "string"
	) {
		state.apply_failure = {
			version: value.apply_failure.version,
			at: value.apply_failure.at,
			message: clampMessage(value.apply_failure.message),
			...(value.apply_failure.unmanaged === true
				? { unmanaged: true as const }
				: {}),
		};
	}
	if (
		isRecord(value.applied) &&
		isValidVersion(value.applied.from) &&
		isValidVersion(value.applied.to) &&
		isTimestamp(value.applied.at)
	) {
		state.applied = {
			from: value.applied.from,
			to: value.applied.to,
			at: value.applied.at,
		};
	}
	return state;
};

export const readUpdateState = async (file: string): Promise<UpdateState> => {
	try {
		const info = await fs.lstat(file);
		if (!info.isFile() || info.size > MAX_STATE_BYTES) return { version: 1 };
		return parseUpdateState(JSON.parse(await fs.readFile(file, "utf8")));
	} catch {
		return { version: 1 };
	}
};

export const writeJsonAtomic = async (
	file: string,
	value: unknown,
): Promise<void> => {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await fs.rename(temp, file);
	} catch (error) {
		await fs.rm(temp, { force: true });
		throw error;
	}
};

export const writeUpdateState = (
	file: string,
	state: UpdateState,
): Promise<void> => writeJsonAtomic(file, state);

const isSqliteBusyError = (error: unknown): boolean =>
	["SQLITE_BUSY", "SQLITE_LOCKED"].includes(
		(error as { code?: string } | null)?.code ?? "",
	);

export const tryWithSqliteLock = async <T>(
	lockFile: string,
	timeoutMs: number,
	action: () => T | Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> => {
	await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
	const db = await openSqlite(lockFile);
	try {
		db.exec("PRAGMA busy_timeout = 0");
		const deadline = performance.now() + timeoutMs;
		for (;;) {
			try {
				db.exec("BEGIN IMMEDIATE");
				break;
			} catch (error) {
				if (!isSqliteBusyError(error)) throw error;
				if (performance.now() >= deadline) {
					return { acquired: false };
				}
				await delay(15);
			}
		}
		try {
			const value = await action();
			db.exec("COMMIT");
			return { acquired: true, value };
		} catch (error) {
			try {
				db.exec("ROLLBACK");
			} catch {
				// ignore rollback failure on closed/failed handle
			}
			throw error;
		}
	} finally {
		db.close();
	}
};

/** Serialize short cache reads/writes on `state.json`. */
export const withLockedUpdateState = async <T>(
	file: string,
	action: (state: UpdateState) => T | Promise<T>,
): Promise<T> => {
	const result = await tryWithSqliteLock(
		`${file}.lock.sqlite`,
		5_000,
		async () => action(await readUpdateState(file)),
	);
	if (!result.acquired) {
		throw new Error("Timed out waiting for update state lock");
	}
	return result.value;
};

export const mutateUpdateState = (
	file: string,
	mutate: (state: UpdateState) => UpdateState,
): Promise<UpdateState> =>
	withLockedUpdateState(file, async (state) => {
		const next = mutate(state);
		await writeUpdateState(file, next);
		return next;
	});
