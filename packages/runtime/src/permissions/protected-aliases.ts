import {
	type BigIntStats,
	lstatSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import type { GitHookAlias } from "./git-metadata";

const maxEntries = 4096;

const inode = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}`;

/**
 * Seatbelt path rules do not follow a file's inode to every hard-link alias.
 * Check configured private resources and read-only roots before launch.
 */
function* linkedInodes(
	roots: readonly string[],
	entryLimit: number,
	ignoredObjectDirectories: readonly string[] = [],
	verifiedHooks: readonly GitHookAlias[] = [],
): Generator<string> {
	const pending = roots.map((entry) => {
		try {
			return realpathSync(entry);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return entry;
			throw error;
		}
	});
	const visited = new Set<string>();
	const ignored = new Set(ignoredObjectDirectories);
	const inputs = new Set(roots);
	const hooks = new Map(
		verifiedHooks
			.filter((hook) => inputs.has(hook.target))
			.map((hook) => [hook.path, hook.target]),
	);
	const verifiedHook = (file: string): boolean => {
		const target = hooks.get(file);
		if (!target) return false;
		try {
			return realpathSync(file) === target && lstatSync(target).isFile();
		} catch {
			// An unknown target requires the original strict scan.
			return false;
		}
	};
	while (pending.length) {
		const file = pending.pop();
		if (!file || visited.has(file)) continue;
		visited.add(file);
		if (visited.size > entryLimit)
			throw new Error("protected_alias_index_unavailable");
		try {
			const metadata = lstatSync(file, { bigint: true });
			if (metadata.isFile() && metadata.nlink > 1n) yield inode(metadata);
			if (metadata.isSymbolicLink() && ignored.size) {
				if (verifiedHook(file)) continue;
				// Other metadata may point outside the Git directory. Keep
				// the strict scan for layouts with unresolved write authority.
				pending.push(...ignored);
				ignored.clear();
			} else if (metadata.isDirectory()) {
				const children = readdirSync(file);
				if (children.length + pending.length + visited.size > entryLimit)
					throw new Error("protected_alias_index_unavailable");
				for (const name of children) {
					const child = path.join(file, name);
					if (!ignored.has(child)) pending.push(child);
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

export const findProtectedAliases = (
	roots: readonly string[],
): ReadonlySet<string> => new Set(linkedInodes(roots, maxEntries));

/** Git object stores can exceed the budget for private credential directories. */
export const hasReadOnlyAliases = (
	roots: readonly string[],
	target?: BigIntStats,
	ignoredObjectDirectories?: readonly string[],
	verifiedHooks?: readonly GitHookAlias[],
): boolean => {
	if (target && target.nlink <= 1n) return false;
	const targetInode = target && inode(target);
	for (const candidate of linkedInodes(
		roots,
		Infinity,
		ignoredObjectDirectories,
		verifiedHooks,
	)) {
		if (!targetInode || targetInode === candidate) return true;
	}
	return false;
};

export const isProtectedAlias = (
	stat: BigIntStats,
	paths: readonly string[],
): boolean => stat.nlink > 1n && findProtectedAliases(paths).has(inode(stat));
