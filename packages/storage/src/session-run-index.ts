import type { Dirent } from "node:fs";
import { promises as fs, lstatSync } from "node:fs";
import path from "node:path";
import { readRunLogLines } from "./run-log-reader";

/** One run log of a session, as recorded in `state.db` (`session_runs`). */
export type SessionRunEntry = {
	session_id: string;
	run_id: string;
	/** Canonical `YYYY/MM/DD/<name>.jsonl` path relative to `sessionsDir`. */
	rel_path: string;
	started_at: string;
};

/** Narrow write capability handed to run log writers. */
export type SessionRunRecorder = {
	recordSessionRun: (entry: SessionRunEntry) => Promise<void>;
};

const REL_PATH_PATTERN = /^\d{4}\/\d{2}\/\d{2}\/[^/\\]+\.jsonl$/;

/**
 * Index ordering compares `started_at` as text, so store one fixed UTC form
 * (`toISOString`); mixed precisions or offsets would otherwise misorder.
 */
export const normalizeRunStartedAt = (startedAt: string): string => {
	const time = Date.parse(startedAt);
	return Number.isFinite(time) ? new Date(time).toISOString() : startedAt;
};

const isRegularFile = (file: string): boolean => {
	try {
		return lstatSync(file).isFile();
	} catch {
		return false;
	}
};

/** Returns the canonical relative path, or undefined outside the date layout. */
export const toRunLogRelPath = (
	sessionsDir: string,
	file: string,
): string | undefined => {
	const relative = path
		.relative(sessionsDir, file)
		.split(path.sep)
		.join("/")
		.replace(/\.gz$/, "");
	return REL_PATH_PATTERN.test(relative) ? relative : undefined;
};

/**
 * Resolves an indexed run log to a readable path: plain wins, then `.gz`.
 * Only regular files qualify (no symlink/FIFO/directory, as the directory scan
 * admitted only `isFile()` entries). Returns undefined otherwise.
 */
export const resolveIndexedRunLog = (
	sessionsDir: string,
	relPath: string,
): string | undefined => {
	if (!REL_PATH_PATTERN.test(relPath)) return undefined;
	const plain = path.join(sessionsDir, ...relPath.split("/"));
	if (isRegularFile(plain)) return plain;
	if (isRegularFile(`${plain}.gz`)) return `${plain}.gz`;
	return undefined;
};

type RunHeader = {
	type?: unknown;
	run_id?: unknown;
	session_id?: unknown;
	started_at?: unknown;
};

const readHeader = async (file: string): Promise<RunHeader | null> => {
	for await (const line of readRunLogLines(file)) {
		try {
			const header = JSON.parse(line) as RunHeader;
			if (!header || typeof header !== "object") return null;
			return header.type === "header" ? header : null;
		} catch {
			return null;
		}
	}
	return null;
};

const errorCode = (error: unknown): string | undefined =>
	(error as NodeJS.ErrnoException | undefined)?.code;

/** Only a vanished entry is empty; other failures must not mark a backfill complete. */
const readDirs = async (directory: string): Promise<Dirent[]> => {
	try {
		return (await fs.readdir(directory, {
			withFileTypes: true,
			encoding: "utf8",
		})) as Dirent[];
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR")
			return [];
		throw error;
	}
};

/**
 * Per-file errors that are permanent properties of that file (removed, not a
 * regular file, corrupt gzip/JSON) skip it, as the legacy scan did. System
 * errors (EMFILE, EACCES, EIO, ...) abort the scan so it is retried later.
 */
const isPermanentFileError = (error: unknown): boolean => {
	const code = errorCode(error);
	return (
		code === undefined ||
		code === "ENOENT" ||
		code === "ELOOP" ||
		code === "EISDIR" ||
		code.startsWith("Z_") ||
		code.startsWith("ERR_")
	);
};

const listRunLogFiles = async (sessionsDir: string): Promise<string[]> => {
	const files: string[] = [];
	for (const year of await readDirs(sessionsDir)) {
		if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
		const yearPath = path.join(sessionsDir, year.name);
		for (const month of await readDirs(yearPath)) {
			if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
			const monthPath = path.join(yearPath, month.name);
			for (const day of await readDirs(monthPath)) {
				if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
				const dayPath = path.join(monthPath, day.name);
				const entries = (await readDirs(dayPath)).filter(
					(entry) => entry.isFile() && /\.jsonl(?:\.gz)?$/.test(entry.name),
				);
				const plain = new Set(
					entries
						.filter((entry) => entry.name.endsWith(".jsonl"))
						.map((entry) => entry.name),
				);
				for (const entry of entries) {
					// Plain wins over an interrupted compression's `.gz` twin.
					if (entry.name.endsWith(".gz") && plain.has(entry.name.slice(0, -3)))
						continue;
					files.push(path.join(dayPath, entry.name));
				}
			}
		}
	}
	return files;
};

const SCAN_CONCURRENCY = 16;

/**
 * Reads every run log header under `sessionsDir` (the legacy, store-wide scan)
 * and returns one entry per log whose header names a session. Unreadable or
 * header-less files are skipped, as the legacy history scan did.
 */
export const scanSessionRunLogs = async (
	sessionsDir: string,
): Promise<SessionRunEntry[]> => {
	const files = await listRunLogFiles(sessionsDir);
	const entries: SessionRunEntry[] = [];
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < files.length) {
			const file = files[next++] as string;
			const relPath = toRunLogRelPath(sessionsDir, file);
			if (!relPath) continue;
			try {
				const header = await readHeader(file);
				if (!header || typeof header.session_id !== "string") continue;
				const startedAt =
					typeof header.started_at === "string"
						? header.started_at
						: new Date((await fs.stat(file)).mtimeMs).toISOString();
				entries.push({
					session_id: header.session_id,
					run_id:
						typeof header.run_id === "string"
							? header.run_id
							: path.posix.basename(relPath, ".jsonl"),
					rel_path: relPath,
					started_at: normalizeRunStartedAt(startedAt),
				});
			} catch (error) {
				if (isPermanentFileError(error)) continue;
				next = files.length; // stop the other workers; nothing is recorded
				throw error;
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, worker),
	);
	return entries;
};
