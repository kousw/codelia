import { spawn } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { isValidVersion } from "./semver";

export const UPDATE_REEXEC_ENV = "CODELIA_UPDATE_REEXEC";
const DEFAULT_LAUNCHER_ENTRY = path.join("dist", "index.cjs");

export const readInstalledVersion = (packageRoot: string): string | null => {
	try {
		const manifest = JSON.parse(
			fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		) as { name?: unknown; version?: unknown };
		return manifest.name === "@codelia/cli" && isValidVersion(manifest.version)
			? manifest.version
			: null;
	} catch {
		return null;
	}
};

export type Reexec = (options: {
	entry: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}) => Promise<number | null>;

/** Starts the freshly installed launcher; null when it could not start. */
export const reexecLauncher: Reexec = (options) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, [options.entry, ...options.args], {
			stdio: "inherit",
			env: options.env,
		});
		child.on("error", () => resolve(null));
		child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
	});

/** Resolves the launcher script from the installed package's own `bin` field. */
export const launcherEntry = (packageRoot: string): string => {
	const fallback = path.join(packageRoot, DEFAULT_LAUNCHER_ENTRY);
	let bin: unknown;
	try {
		bin = (
			JSON.parse(
				fsSync.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
			) as { bin?: unknown }
		).bin;
	} catch {
		return fallback;
	}
	const relative =
		typeof bin === "string"
			? bin
			: typeof bin === "object" && bin !== null
				? (bin as Record<string, unknown>).codelia
				: undefined;
	if (typeof relative !== "string" || relative.length === 0) return fallback;
	const entry = path.resolve(packageRoot, relative);
	const inside = path.relative(packageRoot, entry);
	if (inside.startsWith("..") || path.isAbsolute(inside)) return fallback;
	return fsSync.existsSync(entry) ? entry : fallback;
};
