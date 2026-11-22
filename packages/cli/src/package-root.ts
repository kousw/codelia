import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const installedCliRoot = (file: string): string | null => {
	let candidate = file;
	while (path.dirname(candidate) !== candidate) {
		const scope = path.dirname(candidate);
		if (
			path.basename(candidate) === "cli" &&
			path.basename(scope) === "@codelia" &&
			path.basename(path.dirname(scope)) === "node_modules"
		) {
			return candidate;
		}
		candidate = scope;
	}
	return null;
};

/** Real path of the running `@codelia/cli` package root (symlinks resolved). */
export const resolveCliPackageRoot = (
	scriptPath: string | undefined = process.argv[1],
): string | null => {
	if (!scriptPath) return null;
	try {
		const resolvedScriptPath = fsSync.realpathSync(scriptPath);
		const installed = installedCliRoot(resolvedScriptPath);
		if (installed) return installed;
		const scriptDir = path.dirname(resolvedScriptPath);
		if (path.basename(scriptDir) === "dist") {
			return path.dirname(scriptDir);
		}
		return scriptDir;
	} catch {
		return null;
	}
};

/** Fallback to module path if the bin link disappeared during replacement. */
export const resolveLoadedCliPackageRoot = (): string | null => {
	const fromArgv = resolveCliPackageRoot();
	if (fromArgv) return fromArgv;
	const moduleDir =
		typeof __dirname === "string"
			? __dirname
			: path.dirname(fileURLToPath(import.meta.url));
	return (
		installedCliRoot(moduleDir) ??
		(path.basename(moduleDir) === "dist" ? path.dirname(moduleDir) : null)
	);
};
