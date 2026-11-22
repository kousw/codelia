import { execFile } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import type { InstallMethod } from "./install-method";
import { readInstalledVersion } from "./launcher-entry";
import { CLI_PACKAGE_NAME, resolveRegistryUrl } from "./registry";
import { compareVersions, isNewerVersion } from "./semver";
import {
	clampMessage,
	mutateUpdateState,
	readUpdateState,
	resolveInstallApplyLockFile,
	tryWithSqliteLock,
	type UpdatePaths,
} from "./state";

const APPLY_LOCK_WAIT_MS = 250;
const NPM_PREFIX_TIMEOUT_MS = 10_000;
const NPM_INSTALL_TIMEOUT_MS = 120_000;

export type CommandResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type CommandRunner = (options: {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
}) => Promise<CommandResult>;

const defaultRunner: CommandRunner = ({ command, args, env, timeoutMs }) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				env,
				timeout: timeoutMs,
				maxBuffer: 4 * 1024 * 1024,
				encoding: "utf8",
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (!error) {
					resolve({ code: 0, stdout, stderr });
					return;
				}
				const exitCode = typeof error.code === "number" ? error.code : 1;
				resolve({
					code: exitCode,
					stdout: stdout ?? "",
					stderr: stderr || error.message,
				});
			},
		);
	});

const canonicalDir = (target: string): string => {
	const resolved = path.resolve(target);
	try {
		return fsSync.realpathSync(resolved);
	} catch {
		return resolved;
	}
};

const summarizeStderr = (stderr: string, fallback: string): string => {
	const lines = stderr
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const npmErr = lines.find(
		(l) => l.startsWith("npm error") || l.startsWith("npm ERR!"),
	);
	return clampMessage(npmErr ?? lines.at(-1) ?? fallback);
};

export type ApplyUpdateResult =
	| { status: "installed"; from: string; to: string }
	| { status: "changed"; installed: string }
	| { status: "superseded" }
	| { status: "deferred" }
	| { status: "failed"; message: string; unmanaged?: true };

export type ApplyUpdateOptions = {
	paths: UpdatePaths;
	method: InstallMethod;
	from: string;
	to: string;
	configuredChannel: string | null;
	env?: NodeJS.ProcessEnv;
	runner?: CommandRunner;
	now?: () => number;
};

/**
 * In-place global npm update serialized by a short interprocess SQLite lock.
 * Verifies the prefix before installing and verifies the installed manifest version after.
 */
export const applyUpdate = async (
	options: ApplyUpdateOptions,
): Promise<ApplyUpdateResult> => {
	const env = options.env ?? process.env;
	const runner = options.runner ?? defaultRunner;
	const now = options.now ?? Date.now;

	if (
		options.method.kind !== "npm-global" ||
		!options.method.prefix ||
		!options.method.autoApply.supported
	) {
		return {
			status: "failed",
			message: options.method.autoApply.supported
				? "Unsupported installation layout"
				: options.method.autoApply.reason,
			unmanaged: true,
		};
	}

	const npmPath = options.method.autoApply.npmPath;
	const expectedPrefix = canonicalDir(options.method.prefix);
	const applyLockFile = resolveInstallApplyLockFile(
		canonicalDir(options.method.packageRoot),
	);

	const locked = await tryWithSqliteLock(
		applyLockFile,
		APPLY_LOCK_WAIT_MS,
		async (): Promise<ApplyUpdateResult> => {
			// Re-verify installed version after acquiring the lock (another process may have updated it).
			const onDisk = readInstalledVersion(options.method.packageRoot);
			if (onDisk && onDisk !== options.from) {
				return { status: "changed", installed: onDisk };
			}

			// Re-verify cached target hasn't moved backward or been replaced.
			const currentState = await readUpdateState(options.paths.stateFile);
			if (
				currentState.latest_version &&
				(compareVersions(currentState.latest_version, options.to) ?? 0) !== 0
			) {
				return { status: "superseded" };
			}
			if (!isNewerVersion(options.to, options.from)) {
				return { status: "changed", installed: options.from };
			}

			let registryUrl: string;
			try {
				registryUrl = resolveRegistryUrl(env);
			} catch (error) {
				const message = clampMessage(
					error instanceof Error ? error.message : String(error),
				);
				return { status: "failed", message };
			}

			const npmEnv: NodeJS.ProcessEnv = {
				...env,
				npm_config_registry: registryUrl,
				npm_config_update_notifier: "false",
			};

			const failAndRecord = async (
				message: string,
				unmanaged?: true,
			): Promise<ApplyUpdateResult> => {
				await recordApplyFailure(
					options.paths.stateFile,
					options.to,
					message,
					now,
					unmanaged,
				);
				return unmanaged
					? { status: "failed", message, unmanaged }
					: { status: "failed", message };
			};

			// Confirm the active `npm` manages this global prefix (do NOT pass `--prefix`
			// here, because `--prefix` echoes back whatever value is passed).
			const prefixProbe = await runner({
				command: npmPath,
				args: ["prefix", "-g"],
				env: npmEnv,
				timeoutMs: NPM_PREFIX_TIMEOUT_MS,
			});
			if (prefixProbe.code !== 0) {
				return failAndRecord(
					summarizeStderr(prefixProbe.stderr, "npm prefix check failed"),
				);
			}
			const reportedPrefix = canonicalDir(prefixProbe.stdout.trim());
			if (reportedPrefix !== expectedPrefix) {
				return failAndRecord(
					"npm global prefix does not match installation prefix",
					true,
				);
			}

			const install = await runner({
				command: npmPath,
				args: [
					"install",
					"-g",
					"--prefix",
					expectedPrefix,
					"--no-audit",
					"--no-fund",
					`${CLI_PACKAGE_NAME}@${options.to}`,
				],
				env: npmEnv,
				timeoutMs: NPM_INSTALL_TIMEOUT_MS,
			});
			if (install.code !== 0) {
				return failAndRecord(
					summarizeStderr(
						install.stderr,
						`npm install exited with status ${install.code}`,
					),
				);
			}

			const verified = readInstalledVersion(options.method.packageRoot);
			if (verified !== options.to) {
				return failAndRecord(
					verified
						? `Expected version ${options.to} after install, found ${verified}`
						: `Could not verify installed version ${options.to} after install`,
				);
			}

			const appliedAt = new Date(now()).toISOString();
			await mutateUpdateState(options.paths.stateFile, (state) => {
				const next = {
					...state,
					version: 1 as const,
					applied: { from: options.from, to: options.to, at: appliedAt },
				};
				delete next.apply_failure;
				return next;
			}).catch(() => undefined);

			return { status: "installed", from: options.from, to: options.to };
		},
	);

	if (!locked.acquired) {
		return { status: "deferred" };
	}
	return locked.value;
};

const recordApplyFailure = async (
	stateFile: string,
	version: string,
	message: string,
	now: () => number,
	unmanaged?: true,
): Promise<void> => {
	const at = new Date(now()).toISOString();
	await mutateUpdateState(stateFile, (state) => ({
		...state,
		version: 1,
		apply_failure: {
			version,
			at,
			message: clampMessage(message),
			...(unmanaged ? { unmanaged: true as const } : {}),
		},
	})).catch(() => undefined);
};
