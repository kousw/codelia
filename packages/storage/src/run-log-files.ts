import {
	promises as fs,
	lstatSync,
	readdirSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import path from "node:path";
import type {
	LlmUsageRecord,
	SessionHeader,
	StoragePaths,
} from "@codelia/core";
import { getProcessIdentity } from "./process-identity";
import {
	MAX_RUN_LOG_HEADER_BYTES,
	RUN_LOG_ARCHIVE_VERSION,
} from "./run-log-archive";
import { activeRunDirectory, validateRunLogId } from "./run-log-paths";
import { readRunLogChunks } from "./run-log-reader";

const MAX_ACTIVE_RUN_MARKER_BYTES = 256;

export type RunLogCandidate = {
	file: string;
	runId: string;
	sessionId: string;
	datePath: string;
	mtimeMs: number;
	size: number;
	ino: number;
	dev: number;
	diagnostic: boolean;
	compressed: boolean;
	model?: LlmUsageRecord["model"];
};

export const isRegularDirectory = async (
	directory: string,
): Promise<boolean> => {
	try {
		return (await fs.lstat(directory)).isDirectory();
	} catch {
		return false;
	}
};

async function readHeader(
	file: string,
): Promise<(SessionHeader & { session_id: string }) | null> {
	const parts: Buffer[] = [];
	let length = 0;
	for await (const chunk of readRunLogChunks(file)) {
		const newline = chunk.indexOf(10);
		const part = newline < 0 ? chunk : chunk.subarray(0, newline + 1);
		length += part.length;
		if (length > MAX_RUN_LOG_HEADER_BYTES) return null;
		parts.push(part);
		if (newline < 0) continue;
		const record = JSON.parse(Buffer.concat(parts, length).toString("utf8"));
		if (
			record.type !== "header" ||
			typeof record.run_id !== "string" ||
			typeof record.session_id !== "string"
		)
			return null;
		validateRunLogId(record.run_id);
		validateRunLogId(record.session_id);
		return record;
	}
	return null;
}

async function inspectCandidate(
	root: string,
	datePath: string,
	name: string,
	diagnostic: boolean,
): Promise<RunLogCandidate | undefined> {
	const compressed = name.endsWith(".jsonl.gz");
	const file = path.join(root, datePath, name);
	try {
		const stat = await fs.lstat(file);
		const header = await readHeader(file);
		if (
			!stat.isFile() ||
			!header ||
			name !== `${header.run_id}.jsonl${compressed ? ".gz" : ""}` ||
			(compressed &&
				header.meta?.codelia_log_archive_version === RUN_LOG_ARCHIVE_VERSION)
		)
			return undefined;
		return {
			file,
			runId: header.run_id,
			sessionId: header.session_id,
			datePath,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			ino: stat.ino,
			dev: stat.dev,
			diagnostic,
			compressed,
			model: header.model
				? { provider: header.model.provider, name: header.model.name }
				: undefined,
		};
	} catch {
		/* Unknown or incomplete records are retained. */
		return undefined;
	}
}

export async function collectRunLogCandidates(
	root: string,
	diagnostic = false,
): Promise<RunLogCandidate[]> {
	if (!(await isRegularDirectory(root))) return [];
	const candidates: RunLogCandidate[] = [];
	for (const year of await fs.readdir(root, { withFileTypes: true })) {
		if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
		for (const month of await fs.readdir(path.join(root, year.name), {
			withFileTypes: true,
		})) {
			if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
			for (const day of await fs.readdir(
				path.join(root, year.name, month.name),
				{ withFileTypes: true },
			)) {
				if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
				const datePath = path.join(year.name, month.name, day.name);
				const entries = await fs.readdir(path.join(root, datePath), {
					withFileTypes: true,
				});
				const plain = new Set(
					entries
						.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
						.map((entry) => entry.name),
				);
				for (const entry of entries) {
					const compressed = entry.name.endsWith(".jsonl.gz");
					if (
						!entry.isFile() ||
						(!entry.name.endsWith(".jsonl") && (diagnostic || !compressed))
					)
						continue;
					if (compressed && plain.has(entry.name.slice(0, -3))) continue;
					const candidate = await inspectCandidate(
						root,
						datePath,
						entry.name,
						diagnostic,
					);
					if (candidate) candidates.push(candidate);
				}
			}
		}
	}
	return candidates;
}

/**
 * Same candidates as {@link collectRunLogCandidates}, restricted to the given
 * canonical `YYYY/MM/DD/<run>.jsonl` paths (from the state.db run index), so
 * unrelated logs are never opened.
 */
export async function collectRunLogCandidatesAt(
	root: string,
	relPaths: readonly string[],
	diagnostic = false,
): Promise<RunLogCandidate[]> {
	if (!(await isRegularDirectory(root))) return [];
	const candidates: RunLogCandidate[] = [];
	for (const relPath of relPaths) {
		const parts = relPath.split("/");
		const name = parts.pop();
		if (
			!name?.endsWith(".jsonl") ||
			parts.length !== 3 ||
			!/^\d{4}$/.test(parts[0] ?? "") ||
			!/^\d{2}$/.test(parts[1] ?? "") ||
			!/^\d{2}$/.test(parts[2] ?? "") ||
			name.includes("\\")
		)
			continue;
		const datePath = path.join(...parts);
		let selected = name;
		try {
			await fs.lstat(path.join(root, datePath, name));
		} catch {
			if (diagnostic) continue;
			selected = `${name}.gz`;
		}
		const candidate = await inspectCandidate(
			root,
			datePath,
			selected,
			diagnostic,
		);
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

/** Async identity probes stay outside the index guard. Unknown/legacy markers remain protected. */
export async function removeReusedProcessMarkers(
	paths: StoragePaths,
	sessionId: string,
	identify: (pid: number) => Promise<string | null> = (pid) =>
		getProcessIdentity(pid, { canonicalEnvironment: true }),
): Promise<void> {
	const directory = activeRunDirectory(paths, sessionId);
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	for (const entry of entries) {
		const file = path.join(directory, entry);
		try {
			const before = lstatSync(file);
			if (!before.isFile() || before.size > MAX_ACTIVE_RUN_MARKER_BYTES)
				continue;
			const contents = readFileSync(file, "utf8");
			const { pid, identity } = JSON.parse(contents);
			if (
				!Number.isSafeInteger(pid) ||
				pid < 1 ||
				typeof identity !== "string" ||
				!identity
			)
				continue;
			const current = await identify(pid);
			if (!current || current === identity) continue;
			// Do not remove a marker replaced while the process lookup was pending.
			const after = lstatSync(file);
			if (
				after.isFile() &&
				after.ino === before.ino &&
				after.dev === before.dev &&
				after.size === before.size &&
				after.mtimeMs === before.mtimeMs &&
				readFileSync(file, "utf8") === contents
			)
				unlinkSync(file);
		} catch {
			// Malformed, inaccessible or changing markers are not proof of an inactive writer.
		}
	}
}

export function hasActiveRunWriter(
	paths: StoragePaths,
	sessionId: string,
): boolean {
	try {
		const directory = activeRunDirectory(paths, sessionId);
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile()) return true;
			try {
				const file = path.join(directory, entry.name);
				if (lstatSync(file).size > MAX_ACTIVE_RUN_MARKER_BYTES) return true;
				const { pid } = JSON.parse(readFileSync(file, "utf8"));
				if (!Number.isSafeInteger(pid) || pid < 1) return true;
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
				}
			} catch {
				return true;
			}
		}
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}
