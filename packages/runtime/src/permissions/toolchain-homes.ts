import { realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ToolchainHomes = Readonly<{
	CARGO_HOME?: string;
	RUSTUP_HOME?: string;
}>;

/** Resolve explicit toolchain directories and optionally fall back to the login home. */
export function toolchainHomes(
	env: NodeJS.ProcessEnv = process.env,
	fallbackHome: string | null = os.homedir(),
): ToolchainHomes {
	const result: { CARGO_HOME?: string; RUSTUP_HOME?: string } = {};
	for (const [name, fallback] of [
		["CARGO_HOME", ".cargo"],
		["RUSTUP_HOME", ".rustup"],
	] as const) {
		const value =
			env[name] ??
			(fallbackHome === null ? undefined : path.join(fallbackHome, fallback));
		if (!value || !path.isAbsolute(value) || /[\p{Cc}]/u.test(value)) continue;
		try {
			const directory = realpathSync(value);
			if (!/[\p{Cc}]/u.test(directory) && statSync(directory).isDirectory())
				result[name] = directory;
		} catch (error) {
			if (
				!["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw error;
		}
	}
	return Object.freeze(result);
}
