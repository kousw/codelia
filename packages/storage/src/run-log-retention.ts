import {
	lstatSync,
	unlinkSync,
	linkSync,
	renameSync,
	utimesSync,
	promises as fs,
} from "node:fs";
import path from "node:path";
import type {
	LlmUsageRecord,
	SessionStateSummary,
	StoragePaths,
} from "@codelia/core";
import { prepareCompressedLog } from "./run-log-compression";
import {
	collectRunLogCandidates,
	hasActiveRunWriter,
	isRegularDirectory,
	removeReusedProcessMarkers,
	type RunLogCandidate,
} from "./run-log-files";
import { preserveRunUsage } from "./run-log-usage";
import type { SessionStateStoreImpl } from "./session-state";

export const RUN_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export type RunLogCleanupResult = {
	deleted: number;
	compressed: number;
	skipped: number;
	failed: number;
	reclaimed_bytes: number;
};

const eligible = (
	summary: SessionStateSummary | null,
	newestMtime: number,
	now: number,
): boolean => {
	if (!summary || summary.pinned) return false;
	const updatedAt = Date.parse(summary.updated_at);
	if (!Number.isFinite(updatedAt)) return false;
	return (
		Boolean(summary.archived_at) || now - newestMtime >= RUN_LOG_RETENTION_MS
	);
};

type PreparedLog = Awaited<ReturnType<typeof prepareCompressedLog>>;
type CleanupContext = {
	paths: StoragePaths;
	sessions: SessionStateStoreImpl;
	now: number;
	result: RunLogCleanupResult;
};

/** Synchronous: the caller holds the index guard through source publication. */
function commitCandidate(
	candidate: RunLogCandidate,
	compressed: PreparedLog | undefined,
	result: RunLogCleanupResult,
): void {
	try {
		const stat = lstatSync(candidate.file);
		if (
			!stat.isFile() ||
			stat.ino !== candidate.ino ||
			stat.dev !== candidate.dev ||
			stat.size !== candidate.size ||
			stat.mtimeMs !== candidate.mtimeMs
		) {
			result.skipped++;
			return;
		}
		if (compressed) {
			const target = candidate.compressed
				? candidate.file
				: `${candidate.file}.gz`;
			if (candidate.compressed) renameSync(compressed.temporary, target);
			else linkSync(compressed.temporary, target); // A separate existing archive is never overwritten.
			utimesSync(target, stat.atime, stat.mtime);
			if (!candidate.compressed) unlinkSync(candidate.file);
			result.compressed++;
			result.reclaimed_bytes += Math.max(0, stat.size - compressed.size);
		} else {
			unlinkSync(candidate.file);
			result.deleted++;
			result.reclaimed_bytes += stat.size;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.failed++;
	}
}

async function processCandidate(
	context: CleanupContext,
	candidate: RunLogCandidate,
	newestMtime: number,
	usage: readonly LlmUsageRecord[],
): Promise<void> {
	const { paths, sessions, now, result } = context;
	let compressed: PreparedLog | undefined;
	try {
		if (!candidate.diagnostic)
			compressed = await prepareCompressedLog(candidate.file, usage);
		await sessions.withRetentionGuard(candidate.sessionId, (summary) => {
			if (
				hasActiveRunWriter(paths, candidate.sessionId) ||
				!eligible(summary, newestMtime, now)
			) {
				result.skipped++;
				return;
			}
			commitCandidate(candidate, compressed, result);
		});
	} catch {
		result.failed++;
	} finally {
		if (compressed) await fs.rm(compressed.temporary, { force: true });
	}
}

export async function cleanupRunLogs(options: {
	paths: StoragePaths;
	sessions: SessionStateStoreImpl;
	now?: number;
	sessionId?: string;
}): Promise<RunLogCleanupResult> {
	const { paths, sessions } = options;
	const now = options.now ?? Date.now();
	const result: RunLogCleanupResult = {
		deleted: 0,
		compressed: 0,
		skipped: 0,
		failed: 0,
		reclaimed_bytes: 0,
	};
	const context: CleanupContext = { paths, sessions, now, result };
	if (!(await isRegularDirectory(paths.sessionsDir))) return result;
	const candidates = [
		...(await collectRunLogCandidates(paths.sessionsDir)),
		...(await collectRunLogCandidates(
			path.join(paths.sessionsDir, "diagnostics"),
			true,
		)),
	];
	const groups = new Map<string, RunLogCandidate[]>();
	for (const candidate of candidates) {
		if (options.sessionId && candidate.sessionId !== options.sessionId)
			continue;
		const group = groups.get(candidate.sessionId) ?? [];
		group.push(candidate);
		groups.set(candidate.sessionId, group);
	}
	for (const [sessionId, group] of groups) {
		await removeReusedProcessMarkers(paths, sessionId);
		if (hasActiveRunWriter(paths, sessionId)) {
			result.skipped += group.length;
			continue;
		}
		const summary = await sessions.getSummary(sessionId);
		const runMtimes = new Map<string, number>();
		for (const candidate of group)
			runMtimes.set(
				candidate.runId,
				Math.max(runMtimes.get(candidate.runId) ?? 0, candidate.mtimeMs),
			);
		const selected = group.filter((candidate) =>
			eligible(
				summary,
				runMtimes.get(candidate.runId) ?? candidate.mtimeMs,
				now,
			),
		);
		result.skipped += group.length - selected.length;
		if (selected.length === 0) continue;
		try {
			const snapshot = await fs.lstat(
				path.join(paths.sessionsDir, "messages", `${sessionId}.jsonl`),
			);
			if (!snapshot.isFile() || snapshot.size === 0) {
				result.skipped += selected.length;
				continue;
			}
			const usageByRun = new Map<string, LlmUsageRecord[]>();
			for (const candidate of selected)
				usageByRun.set(
					candidate.runId,
					await preserveRunUsage(paths, candidate),
				);
			for (const candidate of selected)
				await processCandidate(
					context,
					candidate,
					runMtimes.get(candidate.runId) ?? candidate.mtimeMs,
					usageByRun.get(candidate.runId) ?? [],
				);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				result.skipped += selected.length;
			else result.failed += selected.length;
		}
	}
	return result;
}
