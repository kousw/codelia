import { spawn } from "node:child_process";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import {
	resolveCliPackageRoot,
	resolveLoadedCliPackageRoot,
} from "../package-root";
import {
	type LaunchUpdateSession,
	NOOP_LAUNCH_UPDATE_SESSION,
} from "../update/launch";
import { UPDATE_REEXEC_ENV } from "../update/launcher-entry";
import { CLI_VERSION } from "../version";
import type { StartupConfirmationId } from "./startup-confirmations";

const resolveTuiBinaryName = (platform: NodeJS.Platform): string =>
	platform === "win32" ? "codelia-tui.exe" : "codelia-tui";

const TUI_PACKAGE_BY_TARGET: Record<string, string> = {
	"darwin-arm64": "@codelia/tui-darwin-arm64",
	"darwin-x64": "@codelia/tui-darwin-x64",
	"linux-arm64": "@codelia/tui-linux-arm64",
	"linux-x64": "@codelia/tui-linux-x64",
	"win32-x64": "@codelia/tui-win32-x64",
};

type PackageJsonResolver = (packageName: string) => string | null;

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const splitArgs = (value: string): string[] =>
	value
		.split(/\s+/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

const isExecutable = (candidate: string): boolean => {
	try {
		fsSync.accessSync(candidate, fsSync.constants.X_OK);
		return true;
	} catch {
		return false;
	}
};

const initStorage = async (): Promise<void> => {
	try {
		const paths = resolveStoragePaths();
		await ensureStorageDirs(paths);
	} catch (error) {
		console.warn(
			`Failed to initialize storage directories: ${describeError(error)}`,
		);
	}
};

const resolveRuntimeRequireBase = (): string => {
	const cliPackageRoot = resolveCliPackageRoot();
	if (cliPackageRoot) {
		return path.resolve(cliPackageRoot, "package.json");
	}
	return path.resolve(process.cwd(), "package.json");
};

const runtimeRequire = createRequire(resolveRuntimeRequireBase());

const resolveBundledRuntimeEntry = (): string | null => {
	try {
		return runtimeRequire.resolve("@codelia/runtime");
	} catch {
		return null;
	}
};

const resolveInstalledPackageJson: PackageJsonResolver = (
	packageName: string,
): string | null => {
	try {
		return runtimeRequire.resolve(`${packageName}/package.json`);
	} catch {
		return null;
	}
};

export const resolvePlatformTuiPackageName = (
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string | null => TUI_PACKAGE_BY_TARGET[`${platform}-${arch}`] ?? null;

export const resolveOptionalTuiBinaryPath = (
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	resolvePackageJson: PackageJsonResolver = resolveInstalledPackageJson,
): string | null => {
	const packageName = resolvePlatformTuiPackageName(platform, arch);
	if (!packageName) {
		return null;
	}
	const packageJsonPath = resolvePackageJson(packageName);
	if (!packageJsonPath) {
		return null;
	}
	return path.resolve(
		path.dirname(packageJsonPath),
		"bin",
		resolveTuiBinaryName(platform),
	);
};

export type RuntimeLaunch = { command: string; args: string[] };

/**
 * Bundled runtime for this CLI. `CODELIA_RUNTIME_CMD` / `_ARGS` stay the
 * developer override, so the launcher resolves nothing when either is set.
 */
export const resolveBundledRuntimeLaunch = (
	env: NodeJS.ProcessEnv,
	resolveRuntimeEntry: () => string | null = resolveBundledRuntimeEntry,
): RuntimeLaunch | undefined => {
	if (env.CODELIA_RUNTIME_CMD || env.CODELIA_RUNTIME_ARGS) return undefined;
	const runtimeEntry = resolveRuntimeEntry();
	return runtimeEntry
		? { command: process.execPath, args: [runtimeEntry] }
		: undefined;
};

/** Private launcher -> TUI handoff; never read from the environment. */
export const TUI_LAUNCH_CONTEXT_FLAG = "--internal-launch-context";

export type TuiLaunchContext = {
	cli_version?: string;
	runtime?: RuntimeLaunch;
	update_notice_file?: string;
	update_control?: { node: string; entry: string };
	startup_confirmations?: readonly StartupConfirmationId[];
};

export const buildTuiLaunchContext = ({
	env,
	cliVersion = CLI_VERSION,
	update = NOOP_LAUNCH_UPDATE_SESSION,
	launcherEntry,
	resolveRuntimeEntry = resolveBundledRuntimeEntry,
}: {
	env: NodeJS.ProcessEnv;
	cliVersion?: string;
	update?: LaunchUpdateSession;
	launcherEntry?: string;
	resolveRuntimeEntry?: () => string | null;
}): TuiLaunchContext => {
	const runtime = resolveBundledRuntimeLaunch(env, resolveRuntimeEntry);
	const version = cliVersion.trim();
	return {
		...(version ? { cli_version: version } : {}),
		...(runtime ? { runtime } : {}),
		...(update.noticeFile ? { update_notice_file: update.noticeFile } : {}),
		// Bind update controls to this launcher, not to PATH or the runtime.
		...(launcherEntry
			? {
					update_control: {
						node: process.execPath,
						entry: path.resolve(launcherEntry),
					},
				}
			: {}),
		...(update.startupConfirmations?.length
			? { startup_confirmations: update.startupConfirmations }
			: {}),
	};
};

const stripLaunchContextArgs = (args: readonly string[]): string[] =>
	args.filter(
		(arg) =>
			arg !== TUI_LAUNCH_CONTEXT_FLAG &&
			!arg.startsWith(`${TUI_LAUNCH_CONTEXT_FLAG}=`),
	);

/**
 * Places the launch context after any CODELIA_TUI_ARGS wrapper prefix and
 * drops any user-forwarded copy of the flag.
 */
export const buildTuiArgs = (
	context: TuiLaunchContext,
	forwarded: readonly string[],
	prefixArgs: readonly string[] = [],
): string[] => [
	...stripLaunchContextArgs(prefixArgs),
	`${TUI_LAUNCH_CONTEXT_FLAG}=${JSON.stringify(context)}`,
	...stripLaunchContextArgs(forwarded),
];

type ResolveTuiCommandOptions = {
	arch?: string;
	cliPackageRoot?: string | null;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	isExecutableCandidate?: (candidate: string) => boolean;
	platform?: NodeJS.Platform;
	resolveOptionalTuiBinary?: (
		platform: NodeJS.Platform,
		arch: string,
	) => string | null;
};

export const resolveTuiCommand = (
	options: ResolveTuiCommandOptions = {},
): string => {
	const env = options.env ?? process.env;
	if (env.CODELIA_TUI_CMD) {
		return env.CODELIA_TUI_CMD;
	}

	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const resolveOptionalBinary =
		options.resolveOptionalTuiBinary ?? resolveOptionalTuiBinaryPath;
	const isExecutableCandidate = options.isExecutableCandidate ?? isExecutable;
	const tuiBinaryName = resolveTuiBinaryName(platform);
	const cwd = options.cwd ?? process.cwd();
	const cliPackageRoot =
		options.cliPackageRoot === undefined
			? resolveCliPackageRoot()
			: options.cliPackageRoot;
	const seen = new Set<string>();
	const optionalTuiBinary = resolveOptionalBinary(platform, arch);
	const localCandidates = [
		...(cliPackageRoot
			? [
					path.resolve(cliPackageRoot, "dist/bin", tuiBinaryName),
					path.resolve(
						cliPackageRoot,
						"../../crates/tui/target/release",
						tuiBinaryName,
					),
					path.resolve(
						cliPackageRoot,
						"../../crates/tui/target/debug",
						tuiBinaryName,
					),
				]
			: []),
		path.resolve(cwd, "target/release", tuiBinaryName),
		path.resolve(cwd, "target/debug", tuiBinaryName),
		path.resolve(cwd, "crates/tui/target/release", tuiBinaryName),
		path.resolve(cwd, "crates/tui/target/debug", tuiBinaryName),
	];
	const candidates = [
		...localCandidates,
		...(optionalTuiBinary ? [optionalTuiBinary] : []),
	];

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableCandidate(candidate)) {
			return candidate;
		}
	}

	return tuiBinaryName;
};

export const runTui = (
	args: string[],
	update: LaunchUpdateSession = NOOP_LAUNCH_UPDATE_SESSION,
	cliPackageRoot: string | null = resolveLoadedCliPackageRoot(),
): void => {
	void initStorage();
	const tuiCmd = resolveTuiCommand({ cliPackageRoot });
	const tuiArgs = process.env.CODELIA_TUI_ARGS
		? splitArgs(process.env.CODELIA_TUI_ARGS)
		: [];
	const context = buildTuiLaunchContext({
		env: process.env,
		update,
		launcherEntry: process.argv[1],
	});
	const tuiEnv = { ...process.env };
	// The re-exec marker is for this launcher only; nested launches make their own decision.
	delete tuiEnv[UPDATE_REEXEC_ENV];
	const child = spawn(tuiCmd, buildTuiArgs(context, args, tuiArgs), {
		stdio: "inherit",
		env: tuiEnv,
	});
	process.once("exit", () => update.dispose());
	child.once("spawn", () => {
		void update.startBackground();
	});
	child.on("exit", (code) => {
		update.dispose();
		process.exitCode = code ?? 0;
	});
	child.on("error", (error) => {
		update.dispose();
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: string }).code ?? "")
				: "";
		const expectedPackage = resolvePlatformTuiPackageName();
		console.error(`Failed to launch TUI (${tuiCmd}): ${describeError(error)}`);
		if (code === "EACCES") {
			console.error(
				"Permission denied while launching TUI. Verify execute permission and PATH entries.",
			);
		} else if (code === "ENOENT") {
			console.error(
				expectedPackage
					? `TUI binary not found. Ensure \`${expectedPackage}\` is installed, or run \`bun run build\` (or \`bun run tui:build\`) and retry.`
					: "TUI binary not found. Run `bun run build` (or `bun run tui:build`) and retry.",
			);
		}
		console.error(
			"Set CODELIA_TUI_CMD/CODELIA_TUI_ARGS to use a custom TUI command.",
		);
		process.exitCode = 1;
	});
};
