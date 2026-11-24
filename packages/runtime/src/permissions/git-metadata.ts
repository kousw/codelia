import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const isMissing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === "ENOENT";

const metadataPathSize = 16 * 1024;
const gitConfigMaxBytes = 256 * 1024;
const maxSymlinkHops = 64;
const maxConfigDepth = 8;
const maxConfigFiles = 32;

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
	worktreeRoot?: string;
	/** Directory spellings that make the whole Git directory read-only. */
	directoryEntries: readonly string[];
	/**
	 * True only when this repository's `.git` marker lives directly at the
	 * workspace root (not a parent repo or nested cwd pointer) and any `.git`
	 * file pointer is verified bidirectionally via `worktrees/<name>/gitdir`
	 * without symlinks.
	 */
	writable: boolean;
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
	const rootDirectory = directories[0];
	const verifyLinkedWorktree = (
		gitDirectory: string,
		commonDirectory: string,
		actualMarker: string,
	): boolean => {
		try {
			if (gitDirectory === commonDirectory) return false;
			if (
				path.dirname(gitDirectory) !== path.join(commonDirectory, "worktrees")
			)
				return false;
			const backPointer = readPointer(path.join(gitDirectory, "gitdir"), "");
			const resolvedBack = path.resolve(gitDirectory, backPointer);
			const backStat = lstatSync(resolvedBack);
			if (backStat.isSymbolicLink() || !backStat.isFile()) return false;
			return (
				realpathSync(path.dirname(resolvedBack)) ===
					path.dirname(actualMarker) &&
				realpathSync(resolvedBack) === actualMarker
			);
		} catch {
			return false;
		}
	};
	for (const directory of new Set(directories)) {
		const fromRoot = directory === rootDirectory;
		const marker = findMarker(directory);
		const localMarker = path.join(directory, ".git");
		if (marker !== localMarker) reservedMarkers.add(localMarker);
		if (!marker) continue;
		if (readOnlyPaths.has(marker)) continue;
		const isWorkspaceRootRepo = fromRoot && marker === localMarker;
		const markerLstat = lstatSync(marker);
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
				worktreeRoot: path.dirname(actualMarker),
				directoryEntries,
				writable:
					isWorkspaceRootRepo &&
					markerLstat.isDirectory() &&
					!markerLstat.isSymbolicLink(),
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
		repositories.push({
			gitDirectory,
			commonDirectory,
			worktreeRoot: path.dirname(actualMarker),
			directoryEntries,
			writable:
				isWorkspaceRootRepo &&
				markerLstat.isFile() &&
				!markerLstat.isSymbolicLink() &&
				verifyLinkedWorktree(gitDirectory, commonDirectory, actualMarker),
		});
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

/**
 * Trace every symlink hop (both intermediate directory symlinks and file
 * symlinks) from `target` to its canonical or reserved absent destination.
 * Throws on symlink cycles or `..` after an absent component so callers can
 * fail closed.
 */
const traceSymlinkHops = (target: string): readonly string[] => {
	const absolute = path.resolve(target);
	const root = path.parse(absolute).root;
	const collected = new Set<string>([target, absolute]);
	let resolvedParts: string[] = [];
	let queue = absolute.slice(root.length).split(path.sep).filter(Boolean);
	let hops = 0;
	while (queue.length > 0) {
		const part = queue.shift() as string;
		if (part === ".") continue;
		if (part === "..") {
			resolvedParts.pop();
			continue;
		}
		const candidate = path.join(root, ...resolvedParts, part);
		const stat = lstatSync(candidate, { throwIfNoEntry: false });
		if (!stat) {
			if (queue.some((entry) => entry === ".."))
				throw new Error("reserved_path_unresolved");
			resolvedParts.push(part, ...queue.filter((entry) => entry !== "."));
			queue = [];
			break;
		}
		if (stat.isSymbolicLink()) {
			// Skip OS root-level symlinks (e.g. macOS /var -> /private/var, /tmp)
			// so they are never emitted as broad read-only rules, while still
			// following them to canonical targets.
			if (path.dirname(candidate) !== root) collected.add(candidate);
			if (++hops > maxSymlinkHops) throw new Error("symlink_chain_too_deep");
			const referent = readlinkSync(candidate);
			const referentParts = referent
				.split(process.platform === "win32" ? /[\\/]/u : "/")
				.filter(Boolean);
			if (path.isAbsolute(referent)) resolvedParts = [];
			queue = [...referentParts, ...queue];
			continue;
		}
		resolvedParts.push(part);
	}
	collected.add(path.join(root, ...resolvedParts));
	return [...collected];
};

const readBoundedTextFile = (filename: string): string | undefined => {
	let fd: number;
	try {
		fd = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > gitConfigMaxBytes)
			throw new Error("unreadable_git_config");
		const bytes = Buffer.alloc(stat.size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		if (length !== stat.size || length > gitConfigMaxBytes)
			throw new Error("unreadable_git_config");
		return new TextDecoder("utf-8", { fatal: true }).decode(
			bytes.subarray(0, length),
		);
	} finally {
		closeSync(fd);
	}
};

const parseGitConfigValue = (raw: string): string => {
	let result = "";
	let inQuotes = false;
	let pendingSpace = "";
	let i = 0;
	while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
	for (; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\") {
			if (i + 1 >= raw.length) {
				// Line continuation: fail closed rather than misparsing multi-line paths.
				throw new Error("unsupported_git_config_continuation");
			}
			const next = raw[++i];
			if (pendingSpace) {
				result += pendingSpace;
				pendingSpace = "";
			}
			if (next === "n") result += "\n";
			else if (next === "t") result += "\t";
			else if (next === "b") result += "\b";
			else if (next === '"' || next === "\\") result += next;
			else throw new Error("unsupported_git_config_escape");
			continue;
		}
		if (ch === '"') {
			if (pendingSpace && !inQuotes) {
				result += pendingSpace;
				pendingSpace = "";
			}
			inQuotes = !inQuotes;
			continue;
		}
		if (!inQuotes && (ch === "#" || ch === ";")) break;
		if (!inQuotes && (ch === " " || ch === "\t")) {
			pendingSpace += ch;
			continue;
		}
		if (pendingSpace) {
			result += pendingSpace;
			pendingSpace = "";
		}
		result += ch;
	}
	if (inQuotes) throw new Error("unterminated_git_config_quote");
	return result;
};

const expandGitHome = (value: string): string => {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
};

type ConfigReferencedPath = Readonly<{
	path: string;
	kind: "config" | "hooks";
}>;

/**
 * Inspect a Git config file (and recursively any included config files) for
 * `include.path`, `includeIf.*.path`, and `core.hooksPath` destinations so
 * they remain read-only when `.git` is opened for writes. Throws on parse
 * ambiguity, unreadable existing configs, or excessive depth/size so callers
 * fail closed.
 */
const collectGitConfigProtectedPaths = (
	configPath: string,
	worktreeRoot: string | undefined,
	seen: Set<string>,
	depth: number,
): readonly ConfigReferencedPath[] => {
	if (depth > maxConfigDepth || seen.size >= maxConfigFiles)
		throw new Error("git_config_include_limit");
	let canonicalConfig = configPath;
	try {
		canonicalConfig = realpathSync(configPath);
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	if (seen.has(canonicalConfig)) return [];
	seen.add(canonicalConfig);
	const content = readBoundedTextFile(canonicalConfig);
	if (content === undefined) return [];

	const results: ConfigReferencedPath[] = [];
	let section = "";
	let continuingIrrelevantLine = false;
	const configDir = path.dirname(canonicalConfig);
	for (const rawLine of content.split(/\r?\n/u)) {
		const trimmed = rawLine.trim();
		if (continuingIrrelevantLine) {
			continuingIrrelevantLine = trimmed.endsWith("\\");
			continue;
		}
		if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
			continue;
		if (trimmed.startsWith("[")) {
			const header =
				/^\[([A-Za-z0-9-]+)(?:\s+"(?:[^"\\]|\\.)*"|\.[A-Za-z0-9.-]+)?\s*\](.*)$/u.exec(
					trimmed,
				);
			if (!header) throw new Error("unsupported_git_config_section");
			section = header[1].toLowerCase();
			const rest = header[2].trim();
			if (!rest || rest.startsWith("#") || rest.startsWith(";")) continue;
			// Inline key=value after section header on the same line.
			const eq = rest.indexOf("=");
			if (eq < 0) continue;
			const key = rest.slice(0, eq).trim().toLowerCase();
			const rawValue = rest.slice(eq + 1);
			if (
				((section === "include" || section === "includeif") &&
					key === "path") ||
				(section === "core" && key === "hookspath")
			) {
				const parsed = parseGitConfigValue(rawValue);
				if (!parsed) throw new Error("empty_git_config_path");
				const expanded = expandGitHome(parsed);
				if (section === "core") {
					const bases = new Set<string>([
						...(worktreeRoot ? [worktreeRoot] : []),
						configDir,
					]);
					for (const base of bases) {
						results.push({
							path: path.isAbsolute(expanded)
								? expanded
								: path.resolve(base, expanded),
							kind: "hooks",
						});
					}
				} else {
					const resolved = path.isAbsolute(expanded)
						? expanded
						: path.resolve(configDir, expanded);
					results.push({ path: resolved, kind: "config" });
					results.push(
						...collectGitConfigProtectedPaths(
							resolved,
							worktreeRoot,
							seen,
							depth + 1,
						),
					);
				}
			}
			continue;
		}
		const eq = rawLine.indexOf("=");
		if (eq < 0) {
			// Bare boolean key; fail closed if it's an unexpected include.path/hooksPath.
			const bareKey = trimmed
				.replace(/[#;].*$/u, "")
				.trim()
				.toLowerCase();
			if (
				((section === "include" || section === "includeif") &&
					bareKey === "path") ||
				(section === "core" && bareKey === "hookspath")
			)
				throw new Error("empty_git_config_path");
			continue;
		}
		const key = rawLine.slice(0, eq).trim().toLowerCase();
		const rawValue = rawLine.slice(eq + 1);
		if (
			((section === "include" || section === "includeif") && key === "path") ||
			(section === "core" && key === "hookspath")
		) {
			const parsed = parseGitConfigValue(rawValue);
			if (!parsed) throw new Error("empty_git_config_path");
			const expanded = expandGitHome(parsed);
			if (section === "core") {
				const bases = new Set<string>([
					...(worktreeRoot ? [worktreeRoot] : []),
					configDir,
				]);
				for (const base of bases) {
					results.push({
						path: path.isAbsolute(expanded)
							? expanded
							: path.resolve(base, expanded),
						kind: "hooks",
					});
				}
			} else {
				const resolved = path.isAbsolute(expanded)
					? expanded
					: path.resolve(configDir, expanded);
				results.push({ path: resolved, kind: "config" });
				results.push(
					...collectGitConfigProtectedPaths(
						resolved,
						worktreeRoot,
						seen,
						depth + 1,
					),
				);
			}
		} else if (trimmed.endsWith("\\")) {
			continuingIrrelevantLine = true;
		}
	}
	return results;
};

export const gitWriteScope = (
	repositories: readonly GitRepositoryLayout[],
): GitWriteScope => {
	const writeRoots = new Set<string>();
	const readOnly = new Set<string>();
	const released = new Set<string>();
	for (const {
		gitDirectory,
		commonDirectory,
		worktreeRoot,
		directoryEntries,
		writable,
	} of repositories) {
		if (!writable) continue;
		const repoReadOnly = new Set<string>();
		const addProtected = (entry: string) => {
			for (const hop of traceSymlinkHops(entry)) repoReadOnly.add(hop);
		};
		const protectHooksDirectory = (hooksPath: string) => {
			addProtected(hooksPath);
			let resolvedHooks: string | undefined;
			try {
				const real = realpathSync(hooksPath);
				if (statSync(real).isDirectory()) resolvedHooks = real;
			} catch (error) {
				if (
					!["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes(
						(error as NodeJS.ErrnoException).code ?? "",
					)
				)
					throw error;
			}
			if (resolvedHooks) {
				for (const entry of readdirSync(resolvedHooks, {
					withFileTypes: true,
				})) {
					if (entry.isSymbolicLink())
						addProtected(path.join(resolvedHooks, entry.name));
				}
			}
		};
		try {
			const objectsDirectory = path.join(commonDirectory, "objects");
			const objectsInfo = path.join(objectsDirectory, "info");
			const configFiles = [
				path.join(commonDirectory, "config"),
				path.join(commonDirectory, "config.worktree"),
				path.join(gitDirectory, "config.worktree"),
			];
			for (const entry of [
				...configFiles,
				path.join(commonDirectory, "hooks"),
				path.join(commonDirectory, "commondir"),
				path.join(gitDirectory, "commondir"),
				path.join(gitDirectory, "gitdir"),
				...gitObjectStoreConfigPaths(objectsDirectory),
				path.join(commonDirectory, "remotes"),
				path.join(commonDirectory, "branches"),
				path.join(commonDirectory, "modules"),
				// Rebase/sequencer todo files can contain `exec <cmd>` lines that
				// execute during a later unconfined `git rebase --continue`.
				path.join(commonDirectory, "rebase-merge"),
				path.join(commonDirectory, "rebase-apply"),
				path.join(commonDirectory, "sequencer"),
				path.join(gitDirectory, "rebase-merge"),
				path.join(gitDirectory, "rebase-apply"),
				path.join(gitDirectory, "sequencer"),
			])
				addProtected(entry);
			// If objects/info is a symlink, protect all hops and its target's
			// alternates files so a confined shell cannot write through the target.
			if (lstatSync(objectsInfo, { throwIfNoEntry: false })?.isSymbolicLink()) {
				const hops = traceSymlinkHops(objectsInfo);
				for (const hop of hops) repoReadOnly.add(hop);
				const targetInfo = hops[hops.length - 1];
				if (targetInfo) {
					addProtected(path.join(targetInfo, "alternates"));
					addProtected(path.join(targetInfo, "http-alternates"));
				}
			}
			// Protect symlinked hook targets (including multi-hop and dangling
			// targets) even when hooks itself is a symlinked directory.
			protectHooksDirectory(path.join(commonDirectory, "hooks"));
			// Protect included config files and custom core.hooksPath directories
			// referenced by existing repo/worktree configs (fail closed on error).
			const seenConfigs = new Set<string>();
			for (const configFile of configFiles) {
				for (const referenced of collectGitConfigProtectedPaths(
					configFile,
					worktreeRoot,
					seenConfigs,
					0,
				)) {
					if (referenced.kind === "hooks")
						protectHooksDirectory(referenced.path);
					else addProtected(referenced.path);
				}
			}
			// Existing linked worktrees resolve their common directory, config and
			// rebase state through these entries.
			const worktrees = path.join(commonDirectory, "worktrees");
			if (lstatSync(worktrees, { throwIfNoEntry: false })?.isDirectory()) {
				for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					for (const name of [
						"gitdir",
						"commondir",
						"config.worktree",
						"rebase-merge",
						"rebase-apply",
						"sequencer",
					])
						addProtected(path.join(worktrees, entry.name, name));
				}
			}
			writeRoots.add(gitDirectory);
			writeRoots.add(commonDirectory);
			for (const entry of directoryEntries) released.add(entry);
			for (const entry of repoReadOnly) readOnly.add(entry);
		} catch {
			// Fail closed for this repository: keep its entire Git directory
			// read-only rather than risking an unguarded config/symlink target.
		}
	}
	return Object.freeze({
		writeRoots: Object.freeze([...writeRoots].sort()),
		readOnlyPaths: Object.freeze([...readOnly].sort()),
		releasedPaths: Object.freeze([...released].sort()),
	});
};
