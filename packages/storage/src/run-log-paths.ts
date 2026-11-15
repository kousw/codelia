import { createHash } from "node:crypto";
import path from "node:path";
import type { StoragePaths } from "@codelia/core";

export const runDatePath = (startedAt: string): string => {
	const date = new Date(startedAt);
	if (!Number.isFinite(date.getTime()))
		throw new Error("Invalid run start time");
	return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
		.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
		.join(path.sep);
};

export const validateRunLogId = (id: string): string => {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
		throw new Error("Invalid run/session log id");
	return id;
};

export const activeRunDirectory = (
	paths: StoragePaths,
	sessionId: string,
): string =>
	path.join(
		paths.sessionsDir,
		"active-runs",
		createHash("sha256").update(sessionId).digest("hex"),
	);

export const usageLogPath = (
	paths: StoragePaths,
	datePath: string,
	runId: string,
): string =>
	path.join(paths.root, "usage", datePath, `${validateRunLogId(runId)}.jsonl`);
