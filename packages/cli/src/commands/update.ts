import { promises as fs } from "node:fs";
import { resolveStoragePaths } from "@codelia/storage";
import { resolveLoadedCliPackageRoot } from "../package-root";
import { applyUpdate, type CommandRunner } from "../update/apply";
import { runRegistryCheck } from "../update/check";
import {
	buildUpdateCommand,
	detectInstallMethod,
	type ResolveNpm,
} from "../update/install-method";
import { commandHint } from "../update/notices";
import type { FetchLike } from "../update/registry";
import { compareVersions } from "../update/semver";
import { resolveUpdateSettings } from "../update/settings";
import { resolveUpdatePaths } from "../update/state";
import { CLI_VERSION } from "../version";

const USAGE = "usage: codelia update [--check]";

export type UpdateCommandDeps = {
	currentVersion?: string;
	packageRoot?: string | null;
	cacheDir?: string;
	configFile?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: FetchLike;
	runner?: CommandRunner;
	resolveNpm?: ResolveNpm;
	out?: (line: string) => void;
	err?: (line: string) => void;
};

/** Explicit user action: check now and install when the layout supports it. */
export const runUpdateCommand = async (
	args: string[],
	deps: UpdateCommandDeps = {},
): Promise<number> => {
	const out = deps.out ?? ((line: string) => console.log(line));
	const err = deps.err ?? ((line: string) => console.error(line));
	if (args.length === 1 && ["-h", "--help", "help"].includes(args[0])) {
		out(USAGE);
		return 0;
	}
	if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
		err(USAGE);
		return 1;
	}
	const checkOnly = args[0] === "--check";
	const env = deps.env ?? process.env;
	const currentVersion = deps.currentVersion ?? CLI_VERSION;
	const packageRoot =
		deps.packageRoot === undefined
			? resolveLoadedCliPackageRoot()
			: deps.packageRoot;
	const method = packageRoot
		? detectInstallMethod({ packageRoot, env, resolveNpm: deps.resolveNpm })
		: null;
	const storagePaths = resolveStoragePaths();
	const paths = resolveUpdatePaths(deps.cacheDir ?? storagePaths.cacheDir);
	await fs.mkdir(paths.dir, { recursive: true });
	const settings = await resolveUpdateSettings({
		env,
		interactive: true,
		configFile: deps.configFile ?? storagePaths.configFile,
	});
	for (const warning of settings.warnings) err(warning);

	const outcome = await runRegistryCheck({
		paths,
		currentVersion,
		configuredChannel: settings.channel,
		env,
		fetchImpl: deps.fetchImpl,
	});
	if (outcome.status === "failed" || outcome.status === "aborted") {
		err(
			`Could not check for updates: ${outcome.status === "failed" ? outcome.message : "aborted"}.`,
		);
		return 1;
	}
	out(
		`Current: ${currentVersion}. Latest (${outcome.channel}): ${outcome.latest}.`,
	);
	if (outcome.status === "up_to_date") {
		out("Codelia is up to date.");
		return 0;
	}
	if (!method || method.kind === "development") {
		out("Running from a source checkout; update it with git.");
		return checkOnly ? 0 : 1;
	}
	const command = buildUpdateCommand(method, {
		version: outcome.latest,
		channel: outcome.channel,
	});
	const hint = method.autoApply.supported
		? "Update with: codelia update"
		: commandHint(command);
	if (checkOnly) {
		out(hint);
		return 0;
	}
	if (!method.autoApply.supported) {
		err(
			`Automatic update is unavailable (${method.autoApply.reason}). ${hint}`,
		);
		return 1;
	}
	const result = await applyUpdate({
		paths,
		method,
		from: currentVersion,
		to: outcome.latest,
		configuredChannel: settings.channel,
		env,
		runner: deps.runner,
	});
	if (result.status === "installed") {
		out(`Updated Codelia ${result.from} -> ${result.to}.`);
		return 0;
	}
	if (result.status === "changed") {
		if ((compareVersions(result.installed, outcome.latest) ?? -1) >= 0) {
			out(`Codelia ${result.installed} is already up to date.`);
			return 0;
		}
		err(
			"Codelia changed version during the update check. Run codelia update again.",
		);
		return 1;
	}
	if (result.status === "superseded") {
		err("The cached update target changed. Run codelia update again.");
		return 1;
	}
	if (result.status === "deferred") {
		err(
			"Another update is in progress for this installation. Run codelia update again after it finishes.",
		);
		return 1;
	}
	err(
		`Update failed: ${result.message}. ${result.unmanaged ? commandHint(null) : hint}`,
	);
	return 1;
};
