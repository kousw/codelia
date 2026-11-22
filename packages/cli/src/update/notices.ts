import { randomBytes } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import type { UpdateMode } from "@codelia/config-loader";
import { buildUpdateCommand, type InstallMethod } from "./install-method";
import { isNewerVersion } from "./semver";
import { type UpdatePaths, type UpdateState, writeJsonAtomic } from "./state";

export const UPDATE_NOTICE_FILE_ENV = "CODELIA_UPDATE_NOTICE_FILE";
const STALE_NOTICE_AGE_MS = 60 * 60 * 1000;

export const commandHint = (command: string | null): string =>
	command
		? `Update with: ${command}`
		: "Update using the package manager that installed Codelia.";

export type BuildStartupNoticesOptions = {
	currentVersion: string;
	mode: UpdateMode;
	method: InstallMethod | null;
	reexecFrom?: string;
};

export const buildStartupNotices = (
	state: UpdateState,
	options: BuildStartupNoticesOptions,
): string[] => {
	const notices: string[] = [];

	if (options.reexecFrom && options.reexecFrom !== options.currentVersion) {
		notices.push(
			`Updated Codelia ${options.reexecFrom} -> ${options.currentVersion}.`,
		);
	}

	if (options.mode === "off") return notices;

	const latest = state.latest_version;
	if (!latest || !isNewerVersion(latest, options.currentVersion)) {
		return notices;
	}

	const channel = state.channel ?? "latest";
	const command = options.method
		? buildUpdateCommand(options.method, { version: latest, channel })
		: null;

	if (state.apply_failure && state.apply_failure.version === latest) {
		const hint = state.apply_failure.unmanaged
			? commandHint(null)
			: commandHint(command);
		notices.push(
			`Automatic update to ${latest} failed (${state.apply_failure.message}). ${hint}`,
		);
		return notices;
	}

	if (options.mode === "notify" || !options.method?.autoApply.supported) {
		const hint = options.method?.autoApply.supported
			? "Run `codelia update` to install."
			: commandHint(command);
		notices.push(
			`Update available: ${options.currentVersion} -> ${latest}. ${hint}`,
		);
	}

	return notices;
};

export const writeStartupNoticeFile = async (
	paths: UpdatePaths,
	notices: readonly string[],
): Promise<string | null> => {
	if (notices.length === 0) return null;
	await fs.mkdir(paths.noticesDir, { recursive: true, mode: 0o700 });
	// Best-effort cleanup of stale notice files left by crashed launches.
	void cleanupStaleNotices(paths.noticesDir);
	const file = path.join(
		paths.noticesDir,
		`notice-${process.pid}-${randomBytes(4).toString("hex")}.json`,
	);
	await writeJsonAtomic(file, { notices: [...notices] });
	return file;
};

export const removeNoticeFileSync = (file: string | null): void => {
	if (!file) return;
	try {
		fsSync.rmSync(file, { force: true });
	} catch {
		// Best-effort cleanup on process exit.
	}
};

const cleanupStaleNotices = async (dir: string): Promise<void> => {
	try {
		const cutoff = Date.now() - STALE_NOTICE_AGE_MS;
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (!entry.startsWith("notice-") || !entry.endsWith(".json")) continue;
			const full = path.join(dir, entry);
			const stat = await fs.lstat(full).catch(() => null);
			if (stat?.isFile() && stat.mtimeMs < cutoff) {
				await fs.rm(full, { force: true }).catch(() => undefined);
			}
		}
	} catch {
		// Ignore background cleanup errors.
	}
};
