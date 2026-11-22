import fsSync from "node:fs";
import path from "node:path";
import { CLI_PACKAGE_NAME } from "./registry";

export type InstallMethodKind =
	| "npm-global"
	| "pnpm"
	| "bun"
	| "yarn"
	| "homebrew"
	| "nix"
	| "volta"
	| "mise"
	| "npx"
	| "local"
	| "development"
	| "unknown";

export type AutoApplyEligibility =
	| { supported: true; npmPath: string }
	| { supported: false; reason: string };

export type InstallMethod = {
	kind: InstallMethodKind;
	packageRoot: string;
	prefix?: string;
	autoApply: AutoApplyEligibility;
};

export type ResolveNpm = (env?: NodeJS.ProcessEnv) => string | null;

const isSafeExecutable = (
	candidate: string,
	platform: NodeJS.Platform,
): boolean => {
	try {
		fsSync.accessSync(candidate, fsSync.constants.X_OK);
		const real = fsSync.realpathSync(candidate);
		const info = fsSync.statSync(real);
		if (!info.isFile()) return false;
		if (platform !== "win32" && typeof process.geteuid === "function") {
			const euid = process.geteuid();
			if (info.uid !== 0 && info.uid !== euid) return false;
			if ((info.mode & 0o022) !== 0) return false;
			const parentInfo = fsSync.statSync(path.dirname(real));
			if (parentInfo.uid !== 0 && parentInfo.uid !== euid) return false;
			if ((parentInfo.mode & 0o022) !== 0) return false;
		}
		return true;
	} catch {
		return false;
	}
};

/**
 * Resolve an `npm` executable from the current Node installation first, then
 * absolute entries on `PATH`. Rejects group/world-writable or foreign-owned
 * binaries on POSIX, while supporting Homebrew Node, nvm, fnm, mise, and root installs.
 */
export const resolveNpmBinary: ResolveNpm = (
	env: NodeJS.ProcessEnv = process.env,
): string | null => {
	const platform = process.platform;
	const names = platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"];
	const candidates: string[] = [];

	const execDir = path.dirname(process.execPath);
	if (path.isAbsolute(execDir)) {
		for (const name of names) {
			candidates.push(path.join(execDir, name));
		}
	}

	const rawPath = env.PATH ?? env.Path ?? "";
	for (const entry of rawPath.split(path.delimiter)) {
		const dir = entry.trim();
		if (!dir || !path.isAbsolute(dir)) continue;
		for (const name of names) {
			candidates.push(path.join(dir, name));
		}
	}

	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		if (isSafeExecutable(candidate, platform)) {
			return candidate;
		}
	}
	return null;
};

const isWritableDir = (dir: string): boolean => {
	try {
		fsSync.accessSync(dir, fsSync.constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

const splitSegments = (target: string): string[] =>
	path.normalize(target).split(path.sep).filter(Boolean);

const hasMatchingBinLink = (
	prefix: string,
	packageRoot: string,
	platform: NodeJS.Platform,
): boolean => {
	const binCandidate =
		platform === "win32"
			? path.join(prefix, "codelia.cmd")
			: path.join(prefix, "bin", "codelia");
	if (!fsSync.existsSync(binCandidate)) return false;
	if (platform === "win32") return true;
	try {
		const resolvedBin = fsSync.realpathSync(binCandidate);
		const resolvedRoot = fsSync.realpathSync(packageRoot);
		const rel = path.relative(resolvedRoot, resolvedBin);
		return !rel.startsWith("..") && !path.isAbsolute(rel);
	} catch {
		return false;
	}
};

export type DetectInstallMethodOptions = {
	packageRoot: string;
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	resolveNpm?: ResolveNpm;
};

const unsupportedInstall = (
	kind: InstallMethodKind,
	packageRoot: string,
	reason: string,
	prefix?: string,
): InstallMethod => ({
	kind,
	packageRoot,
	...(prefix ? { prefix } : {}),
	autoApply: { supported: false, reason },
});

const EXTERNAL_MANAGER_MATCHERS: ReadonlyArray<{
	kind: InstallMethodKind;
	reason: string;
	match: (
		segments: readonly string[],
		lowerSegments: readonly string[],
	) => boolean;
}> = [
	{
		kind: "development",
		reason: "source checkout",
		match: (segments) => !segments.includes("node_modules"),
	},
	{
		kind: "homebrew",
		reason: "managed by Homebrew",
		match: (segments) => segments.includes("Cellar"),
	},
	{
		kind: "nix",
		reason: "managed by Nix/Guix store",
		match: (segments) =>
			(segments[0] === "nix" && segments[1] === "store") ||
			(segments[0] === "gnu" && segments[1] === "store"),
	},
	{
		kind: "npx",
		reason: "ephemeral npx cache",
		match: (_segments, lower) => lower.includes("_npx"),
	},
	{
		kind: "pnpm",
		reason: "managed by pnpm",
		match: (_segments, lower) =>
			lower.includes(".pnpm") || lower.includes("pnpm"),
	},
	{
		kind: "bun",
		reason: "managed by Bun",
		match: (_segments, lower) => lower.includes(".bun"),
	},
	{
		kind: "yarn",
		reason: "managed by Yarn",
		match: (_segments, lower) => lower.includes("yarn"),
	},
	{
		kind: "volta",
		reason: "managed by Volta",
		match: (_segments, lower) => lower.includes(".volta"),
	},
	{
		kind: "mise",
		reason: "managed by mise",
		match: (_segments, lower) =>
			lower.includes("mise") &&
			lower.includes("installs") &&
			lower.includes("npm"),
	},
];

export const detectInstallMethod = (
	options: DetectInstallMethodOptions,
): InstallMethod => {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const resolveNpm = options.resolveNpm ?? resolveNpmBinary;

	let packageRoot = path.resolve(options.packageRoot);
	try {
		packageRoot = fsSync.realpathSync(packageRoot);
	} catch {
		// Keep resolved lexical path when fixture root is virtual.
	}

	const segments = splitSegments(packageRoot);
	const lowerSegments = segments.map((s) => s.toLowerCase());

	for (const matcher of EXTERNAL_MANAGER_MATCHERS) {
		if (matcher.match(segments, lowerSegments)) {
			return unsupportedInstall(matcher.kind, packageRoot, matcher.reason);
		}
	}

	const scopeDir = path.dirname(packageRoot);
	const nodeModulesDir = path.dirname(scopeDir);
	if (
		path.basename(packageRoot) !== "cli" ||
		path.basename(scopeDir) !== "@codelia" ||
		path.basename(nodeModulesDir) !== "node_modules"
	) {
		return unsupportedInstall(
			"unknown",
			packageRoot,
			"unrecognized package layout",
		);
	}

	const parentOfNodeModules = path.dirname(nodeModulesDir);
	const prefix =
		platform === "win32"
			? parentOfNodeModules
			: path.basename(parentOfNodeModules) === "lib"
				? path.dirname(parentOfNodeModules)
				: null;

	if (!prefix || !hasMatchingBinLink(prefix, packageRoot, platform)) {
		return unsupportedInstall(
			"local",
			packageRoot,
			"project-local installation",
		);
	}

	const npmPath = resolveNpm(env);
	if (!npmPath) {
		return unsupportedInstall(
			"npm-global",
			packageRoot,
			"npm executable not found",
			prefix,
		);
	}

	if (!isWritableDir(nodeModulesDir) || !isWritableDir(scopeDir)) {
		return unsupportedInstall(
			"npm-global",
			packageRoot,
			"install directory is not writable",
			prefix,
		);
	}

	return {
		kind: "npm-global",
		packageRoot,
		prefix,
		autoApply: { supported: true, npmPath },
	};
};

export const buildUpdateCommand = (
	method: InstallMethod,
	target: { version?: string; channel: string },
): string | null => {
	const spec = `${CLI_PACKAGE_NAME}@${target.channel}`;
	switch (method.kind) {
		case "npm-global":
			return `npm install -g ${spec}`;
		case "pnpm":
			return `pnpm add -g ${spec}`;
		case "bun":
			return `bun add -g ${spec}`;
		case "yarn":
			return `yarn global add ${spec}`;
		case "volta":
			return `volta install ${spec}`;
		case "homebrew":
			return "brew upgrade codelia";
		case "local":
			return `npm install ${spec}`;
		case "development":
		case "nix":
		case "mise":
		case "npx":
		case "unknown":
			return null;
	}
};
