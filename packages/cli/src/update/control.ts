import { parseUpdateMode, updateConfigValue } from "@codelia/config-loader";
import { resolveStoragePaths } from "@codelia/storage";
import { isMatchingCheckScope, resolveEffectiveChannel } from "./check";
import { detectInstallMethod, type ResolveNpm } from "./install-method";
import { computeRegistryId, resolveRegistryUrl } from "./registry";
import { isNewerVersion } from "./semver";
import { resolveUpdateSettings } from "./settings";
import { readUpdateState, resolveUpdatePaths } from "./state";

type ControlOptions = {
	currentVersion: string;
	packageRoot: string | null;
	configFile?: string;
	cacheDir?: string;
	env: NodeJS.ProcessEnv;
	resolveNpm?: ResolveNpm;
};

// Private launcher-to-TUI commands. Neither queries npm nor installs.
export const runUpdateControl = async (
	args: string[],
	options: ControlOptions,
	out: (line: string) => void,
	err: (line: string) => void,
): Promise<number> => {
	const save = args[0] === "--tui-set-mode";
	const mode = save && args.length === 2 ? parseUpdateMode(args[1]) : undefined;
	if (!mode && !(args.length === 1 && args[0] === "--tui-status")) {
		err("Invalid update settings request.");
		return 1;
	}
	const storage = resolveStoragePaths();
	const configFile = options.configFile ?? storage.configFile;
	if (mode) {
		try {
			await updateConfigValue(configFile, ["update", "mode"], mode);
		} catch {
			// Parser details could expose unrelated parts of the user's config.
			err(
				"Could not save the global update mode. Check the config and its permissions.",
			);
			return 1;
		}
	}

	const settings = await resolveUpdateSettings({
		configFile,
		env: options.env,
		interactive: true,
	});
	const channel = resolveEffectiveChannel(
		options.currentVersion,
		settings.channel,
	);
	const paths = resolveUpdatePaths(options.cacheDir ?? storage.cacheDir);
	const state = await readUpdateState(paths.stateFile);
	let candidate: string | null = null;
	try {
		const registryId = computeRegistryId(resolveRegistryUrl(options.env));
		if (
			isMatchingCheckScope(state, {
				channel,
				configuredChannel: settings.channel,
				registryId,
			}) &&
			state.latest_version &&
			isNewerVersion(state.latest_version, options.currentVersion)
		) {
			candidate = state.latest_version;
		}
	} catch {
		// An invalid registry override cannot match any cached candidate.
	}
	const method = options.packageRoot
		? detectInstallMethod({
				packageRoot: options.packageRoot,
				env: options.env,
				resolveNpm: options.resolveNpm,
			})
		: null;
	out(
		JSON.stringify({
			current_version: options.currentVersion,
			channel,
			candidate,
			saved_mode: settings.savedMode,
			effective_mode: settings.mode,
			mode_source: settings.modeSource,
			auto_apply_supported: method?.autoApply.supported ?? false,
		}),
	);
	return 0;
};
