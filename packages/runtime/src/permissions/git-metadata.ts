import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";

const isMissing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

const metadataPathSize = 16 * 1024;

const readPointer = (filename: string, prefix: string): string => {
	const fd = openSync(
		filename,
		constants.O_RDONLY |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0),
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > metadataPathSize)
			throw new Error("invalid_git_metadata_pointer");
		const bytes = Buffer.alloc(metadataPathSize + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== stat.size || length > metadataPathSize)
			throw new Error("invalid_git_metadata_pointer");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
		const value = text.slice(prefix.length).replace(/[\r\n]+$/u, "");
		if (
			!text.startsWith(prefix) ||
			!value ||
			[...value].some((character) => character < " " || character === "\x7f")
		)
			throw new Error("invalid_git_metadata_pointer");
		return value;
	} finally {
		closeSync(fd);
	}
};

const findMarker = (start: string): string | undefined => {
	let directory = start;
	for (;;) {
		const marker = path.join(directory, ".git");
		try {
			lstatSync(marker);
			return marker;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
};

export type GitRepositoryLayout = Readonly<{
	gitDirectory: string;
	commonDirectory: string;
	/** Directory spellings that make the whole Git directory read-only. */
	directoryEntries: readonly string[];
}>;

type GitMetadataPaths = Readonly<{
	readOnlyPaths: readonly string[];
	repositories: readonly GitRepositoryLayout[];
	// Keep an unused marker reserved without requiring a newer shell adapter.
	reservedMarkers: readonly string[];
	objectDirectories: readonly GitObjectDirectory[];
	hookAliases: readonly GitHookAlias[];
}>;

export type GitHookAlias = Readonly<{ path: string; target: string }>;

export type GitObjectDirectory = Readonly<{
	path: string;
	identity: string;
}>;

export const gitObjectStoreConfigPaths = (directory: string): string[] =>
	["alternates", "http-alternates"].map((name) =>
		path.join(directory, "info", name),
	);

const gitHookAliases = (common: string): GitHookAlias[] => {
	const hooks = path.join(common, "hooks");
	if (!lstatSync(hooks, { throwIfNoEntry: false })?.isDirectory()) return [];
	return readdirSync(hooks, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isSymbolicLink()) return [];
		const filename = path.join(hooks, entry.name);
		try {
			const target = realpathSync(filename);
			return statSync(target).isFile() ? [{ path: filename, target }] : [];
		} catch (error) {
			if (
				["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(
					(error as NodeJS.ErrnoException).code ?? "",
				)
			)
				return [];
			throw error;
		}
	});
};

export const gitObjectDirectoryIdentity = (directory: string): string => {
	const info = lstatSync(directory, { bigint: true });
	if (!info.isDirectory() || realpathSync(directory) !== directory)
		throw new Error("unbound_git_object_directory");
	const infoDirectory = lstatSync(path.join(directory, "info"), {
		throwIfNoEntry: false,
	});
	if (infoDirectory && !infoDirectory.isDirectory())
		throw new Error("unbound_git_object_directory");
	for (const config of gitObjectStoreConfigPaths(directory)) {
		const entry = lstatSync(config, { throwIfNoEntry: false });
		if (entry && !entry.isFile())
			throw new Error("unbound_git_object_directory");
	}
	return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
};

const eligibleObjectDirectory = (
	gitDirectory: string,
	commonDirectory: string,
	marker: string,
): GitObjectDirectory | undefined => {
	try {
		// Use Git's on-disk layout and the selected worktree's own HEAD.
		// Keep the exception narrower than discovery for uncommon layouts.
		const head = readPointer(path.join(gitDirectory, "HEAD"), "");
		if (!/^(?:ref: +refs\/[^ ]+|[\da-f]{40}|[\da-f]{64})$/iu.test(head))
			return undefined;
		if (!lstatSync(path.join(commonDirectory, "refs")).isDirectory())
			return undefined;
		if (gitDirectory !== commonDirectory) {
			if (
				path.dirname(gitDirectory) !== path.join(commonDirectory, "worktrees")
			)
				return undefined;
			const pointer = readPointer(path.join(gitDirectory, "gitdir"), "");
			if (realpathSync(path.resolve(gitDirectory, pointer)) !== marker)
				return undefined;
		}
		const directory = path.join(commonDirectory, "objects");
		return Object.freeze({
			path: directory,
			identity: gitObjectDirectoryIdentity(directory),
		});
	} catch {
		return undefined;
	}
};

/**
 * Resolve only the Git layout of the selected working directories. Reading a
 * pointer never establishes authority over its target.
 */
const discoverGitMetadata = (
	directories: readonly string[],
	includeObjectDirectories: boolean,
): GitMetadataPaths => {
	const readOnlyPaths = new Set<string>();
	const repositories: GitRepositoryLayout[] = [];
	const reservedMarkers = new Set<string>();
	const objectDirectories = new Map<string, GitObjectDirectory>();
	const hookAliases = new Map<string, GitHookAlias>();
	const recordObjects = (
		gitDirectory: string,
		commonDirectory: string,
		marker: string,
	) => {
		for (const alias of gitHookAliases(commonDirectory)) {
			readOnlyPaths.add(alias.target);
			hookAliases.set(alias.path, alias);
		}
		if (!includeObjectDirectories) return;
		const directory = eligibleObjectDirectory(
			gitDirectory,
			commonDirectory,
			marker,
		);
		if (directory) objectDirectories.set(directory.path, directory);
	};
	const addDirectory = (location: string): string => {
		const actual = realpathSync(location);
		if (!statSync(actual).isDirectory())
			throw new Error("invalid_git_metadata_directory");
		readOnlyPaths.add(location);
		readOnlyPaths.add(actual);
		return actual;
	};
	for (const directory of new Set(directories)) {
		const marker = findMarker(directory);
		const localMarker = path.join(directory, ".git");
		if (marker !== localMarker) reservedMarkers.add(localMarker);
		if (!marker) continue;
		if (readOnlyPaths.has(marker)) continue;
		const actualMarker = realpathSync(marker);
		readOnlyPaths.add(marker);
		readOnlyPaths.add(actualMarker);
		const markerInfo = statSync(actualMarker);
		const directoryEntries: string[] = [];
		let gitDirectory: string;
		if (markerInfo.isDirectory()) {
			gitDirectory = actualMarker;
			directoryEntries.push(marker, actualMarker);
		} else {
			const location = path.resolve(
				path.dirname(marker),
				readPointer(actualMarker, "gitdir: "),
			);
			gitDirectory = addDirectory(location);
			directoryEntries.push(location, gitDirectory);
		}
		if (!statSync(path.join(gitDirectory, "HEAD")).isFile())
			throw new Error("invalid_git_metadata_directory");
		const commonPointer = path.join(gitDirectory, "commondir");
		let common: string;
		try {
			common = realpathSync(commonPointer);
		} catch (error) {
			if (!isMissing(error)) throw error;
			recordObjects(gitDirectory, gitDirectory, actualMarker);
			repositories.push({
				gitDirectory,
				commonDirectory: gitDirectory,
				directoryEntries,
			});
			continue;
		}
		readOnlyPaths.add(commonPointer);
		readOnlyPaths.add(common);
		const commonLocation = path.resolve(gitDirectory, readPointer(common, ""));
		const commonDirectory = addDirectory(commonLocation);
		directoryEntries.push(commonLocation, commonDirectory);
		if (!statSync(path.join(commonDirectory, "objects")).isDirectory())
			throw new Error("invalid_git_common_directory");
		recordObjects(gitDirectory, commonDirectory, actualMarker);
		repositories.push({ gitDirectory, commonDirectory, directoryEntries });
	}
	return Object.freeze({
		readOnlyPaths: Object.freeze([...readOnlyPaths].sort()),
		repositories: Object.freeze(repositories),
		reservedMarkers: Object.freeze([...reservedMarkers].sort()),
		objectDirectories: Object.freeze([...objectDirectories.values()]),
		hookAliases: Object.freeze([...hookAliases.values()]),
	});
};

const resolveGitMetadata = (
	directories: readonly string[],
	includeObjectDirectories: boolean,
): GitMetadataPaths => {
	try {
		return discoverGitMetadata(directories, includeObjectDirectories);
	} catch (cause) {
		throw new Error("git_metadata_unavailable", { cause });
	}
};

export const gitMetadataPaths = (...directories: string[]): GitMetadataPaths =>
	resolveGitMetadata(directories, false);

export const gitMetadataWithObjectDirectories = (
	...directories: string[]
): GitMetadataPaths => resolveGitMetadata(directories, true);

/**
 * Ordinary local Git writes for a confined development shell. The Git and
 * common directories become writable, while entries that can redirect Git or
 * run code in a later unconfined Git command stay read-only, including ones
 * that do not exist yet.
 */
export type GitWriteScope = Readonly<{
	writeRoots: readonly string[];
	readOnlyPaths: readonly string[];
	/** Directory spellings that no longer need to be read-only. */
	releasedPaths: readonly string[];
}>;

export const gitWriteScope = (
	repositories: readonly GitRepositoryLayout[],
): GitWriteScope => {
	const writeRoots = new Set<string>();
	const readOnly = new Set<string>();
	const released = new Set<string>();
	for (const {
		gitDirectory,
		commonDirectory,
		directoryEntries,
	} of repositories) {
		writeRoots.add(gitDirectory);
		writeRoots.add(commonDirectory);
		for (const entry of directoryEntries) released.add(entry);
		for (const entry of [
			path.join(commonDirectory, "config"),
			path.join(commonDirectory, "config.worktree"),
			path.join(gitDirectory, "config.worktree"),
			path.join(commonDirectory, "hooks"),
			path.join(commonDirectory, "commondir"),
			path.join(gitDirectory, "commondir"),
			path.join(gitDirectory, "gitdir"),
			...gitObjectStoreConfigPaths(path.join(commonDirectory, "objects")),
			path.join(commonDirectory, "remotes"),
			path.join(commonDirectory, "branches"),
			path.join(commonDirectory, "modules"),
		])
			readOnly.add(entry);
		// Existing linked worktrees resolve their common directory and config
		// through these pointers.
		const worktrees = path.join(commonDirectory, "worktrees");
		if (lstatSync(worktrees, { throwIfNoEntry: false })?.isDirectory()) {
			for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				for (const name of ["gitdir", "commondir", "config.worktree"])
					readOnly.add(path.join(worktrees, entry.name, name));
			}
		}
	}
	return Object.freeze({
		writeRoots: Object.freeze([...writeRoots].sort()),
		readOnlyPaths: Object.freeze([...readOnly].sort()),
		releasedPaths: Object.freeze([...released].sort()),
	});
};
