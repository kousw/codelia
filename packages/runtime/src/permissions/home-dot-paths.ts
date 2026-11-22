import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveReservedTarget, resourceContainsPath } from "./resource-paths";

/** Write grants strictly below home, including explicit dot workspaces, keep their own scope. */
export const homeDotDirectory = (
	writeRoots: readonly string[],
	home = os.homedir(),
): string | undefined => {
	if (!writeRoots.length) return undefined;
	const canonicalHome = resolveReservedTarget(home);
	return writeRoots.some((root) =>
		resourceContainsPath(resolveReservedTarget(root), canonicalHome),
	)
		? canonicalHome
		: undefined;
};

export const isHomeDotTarget = (
	home: string,
	target: string,
	platform: NodeJS.Platform = process.platform,
): boolean => {
	if (!resourceContainsPath(home, target)) return false;
	const root = path.parse(home).root;
	const depth = home.slice(root.length).split(path.sep).filter(Boolean).length;
	const first = target
		.slice(path.parse(target).root.length)
		.split(path.sep)
		.filter(Boolean)[depth];
	return (
		!!first &&
		(first.startsWith(".") ||
			(platform === "darwin" &&
				resourceContainsPath(path.join(home, "Library"), target)))
	);
};

/** Reserve the real destination too, including the future destination of a dangling dotfile link. */
export const homeDotLinkTargets = (home: string): string[] =>
	readdirSync(home, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isSymbolicLink() &&
				isHomeDotTarget(home, path.join(home, entry.name)),
		)
		.map((entry) => resolveReservedTarget(path.join(home, entry.name)));

/** File-tool contexts outlive shell grants. Recheck links at each write selection. */
export const isHomeWriteReserved = (home: string, target: string): boolean =>
	isHomeDotTarget(home, target) ||
	homeDotLinkTargets(home).some((link) => resourceContainsPath(link, target));
