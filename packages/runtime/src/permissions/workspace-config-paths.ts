import { lstatSync, opendirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { resolveProjectConfigPath } from "../config";
import { resourceContainsPath } from "./resource-paths";

export const confinedAutoLaunchDirectoryName = "confined-auto-launch";

export const isWorkspaceConfigName = (root: string, target: string): boolean =>
	resourceContainsPath(path.dirname(resolveProjectConfigPath(root)), target);

const missing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

// Follow an absent path from its last existing ancestor. A dangling link can
// still name a destination that a confined writer must not be able to create.
function resolveConfigTarget(target: string, remaining = 64): string {
	if (!remaining) throw new Error("workspace_config_path_unresolved");
	try {
		return realpathSync(target);
	} catch (error) {
		const parent = path.dirname(target);
		if (!missing(error) || parent === target) throw error;
		const canonicalParent = resolveConfigTarget(parent, remaining - 1);
		if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
			return path.join(canonicalParent, path.basename(target));
		const referent = readlinkSync(target);
		// Normalizing ".." after a named component might skip a symlink lookup.
		let seenName = false;
		for (const part of referent.split(
			process.platform === "win32" ? /[\\/]/u : "/",
		)) {
			if (part === ".." && seenName)
				throw new Error("workspace_config_path_unresolved");
			if (part && part !== "." && part !== "..") seenName = true;
		}
		return resolveConfigTarget(
			path.resolve(canonicalParent, referent),
			remaining - 1,
		);
	}
}

export const workspaceConfigProtection = (root: string) => {
	const config = resolveProjectConfigPath(root);
	const directory = path.dirname(config);
	const readOnlyPaths = new Set([directory]);
	const readOnlyAliasPaths = new Set<string>();
	const reserveTarget = (file: string) => {
		const target = resolveConfigTarget(file);
		readOnlyPaths.add(target);
		readOnlyAliasPaths.add(target);
	};
	if (lstatSync(directory, { throwIfNoEntry: false })) {
		const canonical = resolveConfigTarget(directory);
		readOnlyPaths.add(canonical);
		if (lstatSync(canonical, { throwIfNoEntry: false })?.isDirectory()) {
			const file = path.join(canonical, path.basename(config));
			if (lstatSync(file, { throwIfNoEntry: false })) reserveTarget(file);
			const storage = resolveStoragePaths();
			const globalStorage = [
				resolveStoragePaths({ layout: "home" }).root,
				storage.root,
				storage.configDir,
			].some((entry) => {
				try {
					return realpathSync(entry) === canonical;
				} catch (error) {
					if (!missing(error)) throw error;
					return false;
				}
			});
			// Runtime-owned files are checked separately. Older projects can also
			// have nested lane worktrees, whose contents confer no project authority.
			if (!globalStorage) {
				const worktrees = path.join(canonical, "worktrees");
				const pending = [canonical];
				for (const current of pending) {
					const children = opendirSync(current);
					try {
						for (
							let entry = children.readSync();
							entry;
							entry = children.readSync()
						) {
							const target = path.join(current, entry.name);
							if (target === file || target === worktrees) continue;
							if (entry.isSymbolicLink()) reserveTarget(target);
							else if (entry.isDirectory()) pending.push(target);
							else if (
								entry.isFile() &&
								(lstatSync(target, { throwIfNoEntry: false })?.nlink ?? 0) > 1
							)
								readOnlyAliasPaths.add(target);
						}
					} finally {
						children.closeSync();
					}
				}
			}
		}
	}
	return {
		readOnlyPaths: [...readOnlyPaths].sort(),
		readOnlyAliasPaths: [...readOnlyAliasPaths].sort(),
	};
};
