import { resolveStoragePaths } from "@codelia/storage";
import { applyUpdate, type CommandRunner } from "./apply";
import {
	isMatchingCheckScope,
	resolveEffectiveChannel,
	runRegistryCheck,
	shouldCheckNow,
} from "./check";
import { detectInstallMethod, type ResolveNpm } from "./install-method";
import {
	launcherEntry,
	type Reexec,
	reexecLauncher,
	UPDATE_REEXEC_ENV,
} from "./launcher-entry";
import {
	buildStartupNotices,
	removeNoticeFileSync,
	UPDATE_NOTICE_FILE_ENV,
	writeStartupNoticeFile,
} from "./notices";
import {
	computeRegistryId,
	type FetchLike,
	resolveRegistryUrl,
} from "./registry";
import { isNewerVersion, isValidVersion } from "./semver";
import { resolveUpdateSettings } from "./settings";
import { readUpdateState, resolveUpdatePaths } from "./state";

export type LaunchUpdateSession = {
	tuiEnv: NodeJS.ProcessEnv;
	startBackground: () => Promise<void>;
	dispose: () => void;
};

export type PrepareTuiLaunchResult =
	| { kind: "exit"; exitCode: number }
	| { kind: "launch"; session: LaunchUpdateSession };

export const NOOP_LAUNCH_UPDATE_SESSION: LaunchUpdateSession = {
	tuiEnv: {},
	startBackground: async () => undefined,
	dispose: () => undefined,
};

export type PrepareTuiLaunchOptions = {
	args: string[];
	currentVersion: string;
	packageRoot: string | null;
	interactive?: boolean;
	cacheDir?: string;
	configFile?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	runner?: CommandRunner;
	resolveNpm?: ResolveNpm;
	reexec?: Reexec;
	now?: () => number;
};

const tryResolveRegistryId = (env: NodeJS.ProcessEnv): string | null => {
	try {
		return computeRegistryId(resolveRegistryUrl(env));
	} catch {
		return null;
	}
};

/**
 * Coordinates interactive TUI self-update:
 * 1. If mode is `auto` and a newer cached version is eligible, applies it in-place
 *    and re-execs the updated launcher.
 * 2. Prepares startup notices (`CODELIA_UPDATE_NOTICE_FILE`) for the TUI.
 * 3. Returns a background check hook to run after the TUI spawns.
 */
export const prepareTuiLaunch = async (
	options: PrepareTuiLaunchOptions,
): Promise<PrepareTuiLaunchResult> => {
	const env = options.env ?? process.env;
	const interactive =
		options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const storage = resolveStoragePaths();
	const paths = resolveUpdatePaths(options.cacheDir ?? storage.cacheDir);
	const configFile = options.configFile ?? storage.configFile;
	const settings = await resolveUpdateSettings({
		env,
		interactive,
		configFile,
	});
	const method = options.packageRoot
		? detectInstallMethod({
				packageRoot: options.packageRoot,
				env,
				resolveNpm: options.resolveNpm,
			})
		: null;

	const rawReexecFrom = env[UPDATE_REEXEC_ENV];
	const reexecFrom = isValidVersion(rawReexecFrom) ? rawReexecFrom : undefined;

	if (settings.mode === "off" && !reexecFrom) {
		return { kind: "launch", session: NOOP_LAUNCH_UPDATE_SESSION };
	}

	let state = await readUpdateState(paths.stateFile);

	const currentRegistryId = tryResolveRegistryId(env);
	const effectiveChannel = resolveEffectiveChannel(
		options.currentVersion,
		settings.channel,
	);
	const cacheMatchesScope =
		currentRegistryId !== null &&
		isMatchingCheckScope(state, {
			channel: effectiveChannel,
			configuredChannel: settings.channel,
			registryId: currentRegistryId,
		});

	// Apply cached update before launching the TUI when eligible.
	const cachedTarget = cacheMatchesScope ? state.latest_version : undefined;
	const canAutoApply =
		settings.mode === "auto" &&
		!reexecFrom &&
		Boolean(method?.autoApply.supported) &&
		Boolean(cachedTarget) &&
		isNewerVersion(cachedTarget as string, options.currentVersion) &&
		state.apply_failure?.version !== cachedTarget;

	if (canAutoApply && method && cachedTarget) {
		const applied = await applyUpdate({
			paths,
			method,
			from: options.currentVersion,
			to: cachedTarget,
			configuredChannel: settings.channel,
			env,
			runner: options.runner,
			now: options.now,
		});
		if (applied.status === "installed") {
			const reexec = options.reexec ?? reexecLauncher;
			const exitCode = await reexec({
				entry: launcherEntry(method.packageRoot),
				args: options.args,
				env: {
					...env,
					[UPDATE_REEXEC_ENV]: options.currentVersion,
				},
			});
			if (exitCode !== null) {
				return { kind: "exit", exitCode };
			}
		}
		state = await readUpdateState(paths.stateFile);
	}

	const notices = buildStartupNotices(
		cacheMatchesScope ? state : { version: 1 },
		{
			currentVersion: options.currentVersion,
			mode: settings.mode,
			method,
			reexecFrom,
		},
	);
	let noticeFile: string | null = null;
	try {
		noticeFile = await writeStartupNoticeFile(paths, notices);
	} catch {
		noticeFile = null;
	}

	const abortController = new AbortController();
	const startBackground = async (): Promise<void> => {
		if (settings.mode === "off" || method?.kind === "development") return;
		const regId = tryResolveRegistryId(env);
		if (!regId) return;
		const latestState = await readUpdateState(paths.stateFile);
		if (
			!shouldCheckNow(latestState, {
				now: options.now?.(),
				currentVersion: options.currentVersion,
				configuredChannel: settings.channel,
				registryId: regId,
			})
		) {
			return;
		}
		await runRegistryCheck({
			paths,
			currentVersion: options.currentVersion,
			configuredChannel: settings.channel,
			env,
			fetchImpl: options.fetchImpl,
			signal: abortController.signal,
			now: options.now,
		}).catch(() => undefined);
	};

	const dispose = (): void => {
		abortController.abort();
		removeNoticeFileSync(noticeFile);
		noticeFile = null;
	};

	return {
		kind: "launch",
		session: {
			tuiEnv: noticeFile ? { [UPDATE_NOTICE_FILE_ENV]: noticeFile } : {},
			startBackground,
			dispose,
		},
	};
};
