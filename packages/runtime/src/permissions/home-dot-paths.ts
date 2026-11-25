import { lstatSync, readdirSync, readlinkSync } from "node:fs";
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

// Only disregard a proven cycle of direct, protected names in home. ELOOP
// alone can also mean a long chain or a loop through a mutable directory.
const hasClosedHomeDotCycle = (home: string, start: string): boolean => {
	const seen = new Set<string>();
	let current = start;
	while (seen.size < 64) {
		if (seen.has(current)) return true;
		seen.add(current);
		let link: string;
		try {
			link = readlinkSync(current);
		} catch {
			return false;
		}
		const next = path.resolve(home, link);
		const name = path.basename(next);
		if (
			path.dirname(next) !== home ||
			!isHomeDotTarget(home, next) ||
			(link !== next && link !== name && link !== `.${path.sep}${name}`)
		)
			return false;
		current = next;
	}
	return false;
};

/** Reserve the real destination too, including the future destination of a dangling dotfile link. */
export const homeDotLinkTargets = (home: string): string[] =>
	readdirSync(home, { withFileTypes: true })
		.filter(
			(entry) =>
				entry.isSymbolicLink() &&
				isHomeDotTarget(home, path.join(home, entry.name)),
		)
		.flatMap((entry) => {
			const link = path.join(home, entry.name);
			try {
				return [resolveReservedTarget(link)];
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code === "ELOOP" &&
					hasClosedHomeDotCycle(home, link)
				)
					return [];
				throw error;
			}
		});

/** File-tool contexts outlive shell grants. Recheck links at each write selection. */
export const isHomeWriteReserved = (home: string, target: string): boolean =>
	isHomeDotTarget(home, target) ||
	homeDotLinkTargets(home).some((link) => resourceContainsPath(link, target));

const MAX_HOME_DOT_ALIAS_ENTRIES = 8192;

/**
 * When a Linux home-directory workspace exposes ordinary children as writable
 * bind mounts, an ordinary child sharing an inode with any protected dot-entry
 * (file, Unix socket, or FIFO under any top-level dotfile or dot-directory)
 * could mutate or reach that entry. Scan all top-level dot entries within a
 * bounded entry budget and fail closed if the budget is exceeded or any entry
 * cannot be inspected.
 */
export const hasHomeDotHardLinkAliases = (home: string): boolean => {
	const pending: string[] = [];
	try {
		for (const entry of readdirSync(home, { withFileTypes: true })) {
			if (!entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
			pending.push(path.join(home, entry.name));
		}
		const visited = new Set<string>();
		while (pending.length) {
			const current = pending.pop();
			if (!current || visited.has(current)) continue;
			visited.add(current);
			if (visited.size > MAX_HOME_DOT_ALIAS_ENTRIES) return true;
			const info = lstatSync(current, { bigint: true });
			if (info.isSymbolicLink()) continue;
			if (
				(info.isFile() || info.isSocket() || info.isFIFO()) &&
				info.nlink > 1n
			)
				return true;
			if (info.isDirectory()) {
				for (const child of readdirSync(current)) {
					pending.push(path.join(current, child));
				}
			}
		}
		return false;
	} catch {
		return true;
	}
};
