import { spawn } from "node:child_process";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";

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

const quoteShellWord = (value: string): string =>
	`'${value.replace(/'/g, "'\\''")}'`;

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

const resolveCliPackageRoot = (): string | null => {
	const scriptPath = process.argv[1];
	if (!scriptPath) return null;
	try {
		const resolvedScriptPath = fsSync.realpathSync(scriptPath);
		const scriptDir = path.dirname(resolvedScriptPath);
		if (path.basename(scriptDir) === "dist") {
			return path.dirname(scriptDir);
		}
		return scriptDir;
	} catch {
		return null;
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

export const resolveRuntimeEnvForTui = (
	env: NodeJS.ProcessEnv,
	resolveRuntimeEntry: () => string | null = resolveBundledRuntimeEntry,
): NodeJS.ProcessEnv => {
	if (env.CODELIA_RUNTIME_CMD || env.CODELIA_RUNTIME_ARGS) {
		return env;
	}
	const runtimeEntry = resolveRuntimeEntry();
	if (!runtimeEntry) {
		return env;
	}
	return {
		...env,
		CODELIA_RUNTIME_CMD: process.execPath,
		CODELIA_RUNTIME_ARGS: quoteShellWord(runtimeEntry),
	};
};

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
	const candidates = [
		...(optionalTuiBinary ? [optionalTuiBinary] : []),
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

	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (isExecutableCandidate(candidate)) {
			return candidate;
		}
	}

	return tuiBinaryName;
};

export const runTui = (args: string[]): void => {
	void initStorage();
	const tuiCmd = resolveTuiCommand();
	const tuiArgs = process.env.CODELIA_TUI_ARGS
		? splitArgs(process.env.CODELIA_TUI_ARGS)
		: [];
	const child = spawn(tuiCmd, [...tuiArgs, ...args], {
		stdio: "inherit",
		env: resolveRuntimeEnvForTui(process.env),
	});
	child.on("exit", (code) => {
		process.exitCode = code ?? 0;
	});
	child.on("error", (error) => {
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
