import {
	accessSync,
	constants,
	lstatSync,
	readlinkSync,
	type Stats,
} from "node:fs";
import { posix } from "node:path";

const conventional = ["/bin/bash", "/usr/bin/bash"];
const nixSystemBash = "/run/current-system/sw/bin/bash";
const nixStoreBash = /^\/nix\/store\/[^/]+\/bin\/bash$/u;

type BashEntries = {
	stat: (
		name: string,
	) =>
		| Pick<Stats, "uid" | "mode" | "isDirectory" | "isFile" | "isSymbolicLink">
		| undefined;
	readLink: (name: string) => string;
	canExecute: (name: string) => void;
};
type BashEntry = NonNullable<ReturnType<BashEntries["stat"]>>;

const hostEntries: BashEntries = {
	stat: (name) => lstatSync(name, { throwIfNoEntry: false }),
	readLink: readlinkSync,
	canExecute: (name) => accessSync(name, constants.X_OK),
};

const trustedDirectory = (name: string, entry: BashEntry): boolean =>
	entry.uid === 0 &&
	entry.isDirectory() &&
	((entry.mode & 0o022) === 0 ||
		// Nix builders can create new store entries in a sticky store. They
		// cannot replace the existing root-owned links and outputs we use.
		(name === "/nix/store" && (entry.mode & 0o1000) !== 0));

const resolveCandidate = (candidate: string, entries: BashEntries) => {
	let current = "/";
	let components = candidate.split("/").filter(Boolean);
	let links = 0;
	while (components.length) {
		const component = components[0];
		components = components.slice(1);
		const name = posix.join(current, component);
		const entry = entries.stat(name);
		if (entry?.uid !== 0) return undefined;
		if (entry.isSymbolicLink()) {
			if (++links > 40) return undefined;
			const destination = entries.readLink(name);
			if (posix.isAbsolute(destination)) current = "/";
			components = [...destination.split("/").filter(Boolean), ...components];
			continue;
		}
		if (!components.length) {
			if (!entry.isFile() || (entry.mode & 0o022) !== 0) return undefined;
			entries.canExecute(name);
			return name;
		}
		if (!trustedDirectory(name, entry)) return undefined;
		current = name;
	}
};

export const resolveSystemBash = (
	platform: NodeJS.Platform = process.platform,
	entries: BashEntries = hostEntries,
): string | undefined => {
	if (platform === "win32") return undefined;
	const root = entries.stat("/");
	if (!root || !trustedDirectory("/", root)) return undefined;
	const candidates =
		platform === "linux" ? [nixSystemBash, ...conventional] : conventional;
	for (const candidate of candidates) {
		try {
			const selected = resolveCandidate(candidate, entries);
			if (
				selected &&
				(candidate === nixSystemBash
					? nixStoreBash.test(selected)
					: conventional.includes(selected))
			)
				return selected;
		} catch {
			// This system location is unavailable. Try the next fixed candidate.
		}
	}
};
