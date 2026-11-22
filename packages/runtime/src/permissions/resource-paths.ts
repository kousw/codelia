import {
	type BigIntStats,
	lstatSync,
	opendirSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import path from "node:path";

const lookup = (pathname: string) =>
	lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
const sameEntry = (left: BigIntStats, right: BigIntStats) =>
	left.dev === right.dev && left.ino === right.ino;

export const comparableResourceName = (pathname: string) => {
	const folded = pathname.normalize("NFD").toUpperCase().toLowerCase();
	return process.platform === "win32"
		? folded.replace(/[ .]+(?=[\\/]|$)/gu, "")
		: folded;
};

/** A read-only observation on the directory's own filesystem. */
function distinguishesAsciiCase(parent: string): boolean {
	try {
		const directory = opendirSync(parent);
		try {
			for (let index = 0; index < 16; index++) {
				const name = directory.readSync()?.name;
				if (!name) break;
				const changed = name.replace(/[A-Za-z]/u, (letter) =>
					letter === letter.toLowerCase()
						? letter.toUpperCase()
						: letter.toLowerCase(),
				);
				if (name === changed) continue;
				const original = lookup(path.join(parent, name));
				const alternate = lookup(path.join(parent, changed));
				if (original) return !alternate || !sameEntry(original, alternate);
			}
		} finally {
			directory.closeSync();
		}
	} catch {
		// Without an observation keep equivalent missing names reserved.
	}
	return false;
}

/** Check an already absolute operand against an absolute protected resource. */
export function resourceContainsPath(
	resource: string,
	target: string,
): boolean {
	if (
		target === resource ||
		target.startsWith(
			resource.endsWith(path.sep) ? resource : `${resource}${path.sep}`,
		)
	)
		return true;
	const root = path.parse(resource).root;
	const targetRoot = path.parse(target).root;
	if (comparableResourceName(root) !== comparableResourceName(targetRoot))
		return false;
	const parts = resource.slice(root.length).split(path.sep);
	const overlapping = target
		.slice(targetRoot.length)
		.split(path.sep)
		.slice(0, parts.length);
	if (overlapping.length !== parts.length) return false;
	const candidate = path.join(targetRoot, ...overlapping);
	const namesMayMatch =
		comparableResourceName(resource) === comparableResourceName(candidate);
	try {
		const targetEntry = lookup(candidate);
		if (!targetEntry && !namesMayMatch) return false;
		const protectedEntry = lookup(resource);
		if (protectedEntry || targetEntry)
			return (
				!!protectedEntry &&
				!!targetEntry &&
				sameEntry(protectedEntry, targetEntry)
			);
		if (!namesMayMatch) return false;
		const parent = path.dirname(resource);
		return (
			path.dirname(candidate) !== parent ||
			!/^[\x20-\x7e]+$/u.test(path.basename(resource)) ||
			!/^[\x20-\x7e]+$/u.test(path.basename(candidate)) ||
			path.basename(resource).toLowerCase() !==
				path.basename(candidate).toLowerCase() ||
			!distinguishesAsciiCase(parent)
		);
	} catch {
		return namesMayMatch;
	}
}

const missing = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

// Follow an absent path from its last existing ancestor. A dangling link can
// still name a destination that a confined writer must not be able to create.
export function resolveReservedTarget(target: string, remaining = 64): string {
	if (!remaining) throw new Error("reserved_path_unresolved");
	try {
		return realpathSync(target);
	} catch (error) {
		const parent = path.dirname(target);
		if (!missing(error) || parent === target) throw error;
		const canonicalParent = resolveReservedTarget(parent, remaining - 1);
		if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
			return path.join(canonicalParent, path.basename(target));
		const referent = readlinkSync(target);
		// Normalizing ".." after a named component might skip a symlink lookup.
		let seenName = false;
		for (const part of referent.split(
			process.platform === "win32" ? /[\\/]/u : "/",
		)) {
			if (part === ".." && seenName)
				throw new Error("reserved_path_unresolved");
			if (part && part !== "." && part !== "..") seenName = true;
		}
		return resolveReservedTarget(
			path.resolve(canonicalParent, referent),
			remaining - 1,
		);
	}
}
