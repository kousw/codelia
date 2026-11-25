import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SandboxMode } from "@codelia/shared-types";
import { resolveStoragePaths } from "@codelia/storage";
import { resolveConfigPath } from "../config";
import {
	type DirectoryMutation,
	type FixedFileMutationPaths,
	fixedFileMutation,
} from "../sandbox/file-mutation-helper";
import { isWithin } from "../utils/paths";
import {
	type GitObjectDirectory,
	gitMetadataPaths,
	gitMetadataWithObjectDirectories,
	gitObjectDirectoryIdentity,
	gitObjectStoreConfigPaths,
	gitWriteScope,
} from "./git-metadata";
import {
	homeDotDirectory,
	homeDotLinkTargets,
	isHomeDotTarget,
} from "./home-dot-paths";
import type { ExactLaunchCandidate, LaunchRuleCandidate } from "./launch-rules";
import { LinuxRunscBackend } from "./linux-shell-backend";
import {
	launchMxc,
	probeMxcLauncher,
	resolveMxcLauncher,
} from "./mxc-launcher";
import { findProtectedAliases, hasReadOnlyAliases } from "./protected-aliases";
import { resourceContainsPath } from "./resource-paths";
import { type ShellInvocation, shellInvocationArgs } from "./shell-analysis";
import { shellPathForLaunch } from "./shell-path";
import { resolveSystemBash } from "./system-bash";
import {
	confinedAutoLaunchDirectoryName,
	workspaceConfigProtection,
} from "./workspace-config-paths";

export { isWithin } from "../utils/paths";
export { resolveShellExecutable, shellBinPaths } from "./shell-path";

export type ShellChild = ChildProcessByStdio<
	Writable | null,
	Readable,
	Readable
>;

export type ShellProtection = Readonly<{
	profile: "investigation" | "development" | "full-access";
	root: string;
	cwd: string;
	writeRoots: readonly string[];
	protectedPaths: readonly string[];
	/** Visible to readers, with writes denied independently of writeRoots. */
	readOnlyPaths?: readonly string[];
	/** Deny writes to immediate hidden home entries and their descendants, including future names. */
	homeDotDirectory?: string;
	/** Read-only names whose existing inode aliases also require validation. */
	readOnlyAliasPaths?: readonly string[];
	/** Local macOS admission only. Direct path restrictions still apply. */
	sharedGitObjectDirectories?: readonly GitObjectDirectory[];
	verifiedGitHooks?: readonly import("./git-metadata").GitHookAlias[];
	/**
	 * Git and common directories writable for ordinary local Git operations
	 * (development profile, opted-in backends only). `gitProtectedPaths` stay
	 * read-only inside them, including names that do not exist yet.
	 */
	gitWriteRoots?: readonly string[];
	gitProtectedPaths?: readonly string[];
	protectedAliasPaths?: readonly string[];
	stdin: "closed" | "pipe";
	/** Ordered native PATH components, including empty and relative entries. */
	binPaths?: readonly string[];
	toolchainHomes?: import("./toolchain-homes").ToolchainHomes;
}>;

export type ProtectedShellBackend = {
	/** Explicit opt-in to enforcing readOnlyPaths, including their aliases. */
	supportsReadOnlyPaths?: true;
	supportsHomeDotProtection?: true;
	/**
	 * Opt in only if the backend can deny writes and creation of protected names
	 * that do not exist yet inside an otherwise writable directory (e.g. Seatbelt
	 * path rules). Backends without this capability keep enclosing directories
	 * such as `.git` read-only.
	 */
	supportsAbsentPathDenial?: true;
	/**
	 * Opt in only if direct argv uses the resolved executable and fixed Bash
	 * sources use protection.cwd and binPaths with host-equivalent executable
	 * lookup. Launch Bash without startup hooks, inherited functions or other
	 * changes to builtin or external command resolution.
	 */
	supportsCommandBinding?: true;
	/**
	 * Check the profile on the current host. The launcher must confine all
	 * descendants, hide protected objects, restrict writes to the selected
	 * roots and private scratch, and block outbound and host-local IPC.
	 * Never infer support from installation or OS identity alone.
	 */
	supports: (protection: ShellProtection) => boolean;
	/** Optional additional check for the resolved executable, argv or shell dialect. */
	supportsInvocation?: (
		invocation: ShellInvocation,
		protection: ShellProtection,
	) => boolean;
	/** Legacy callback for the local_test reviewer scope. Never grants a saved launch. */
	supportsLaunchBinding?: (
		candidate: LaunchRuleCandidate,
		protection: ShellProtection,
	) => boolean;
	/** Stable host/backend policy identity. Change it when the execution contract changes. */
	exactLaunchBindingId?: string;
	/** Opt in to executing candidate.invocation unchanged with this protection.
	 * Source candidates require fixed Bash lookup with no startup hooks or injected functions. */
	supportsExactLaunchBinding?: (
		candidate: ExactLaunchCandidate,
		protection: ShellProtection,
	) => boolean;
	/** Return a managed child with private stdio. Setup failure must prevent payload execution. */
	launch: (
		invocation: ShellInvocation,
		protection: ShellProtection,
	) => ShellChild;
};

/** A probe failure or partial implementation cannot authorize a launch. */
export const supportsProtectedShell = (
	backend: ProtectedShellBackend,
	protection: ShellProtection,
	invocation?: ShellInvocation,
): boolean => {
	try {
		return (
			(protection.profile === "full-access" ||
				((!protection.readOnlyPaths?.length ||
					backend.supportsReadOnlyPaths === true) &&
					(!protection.homeDotDirectory ||
						backend.supportsHomeDotProtection === true))) &&
			backend.supports(protection) === true &&
			(!invocation ||
				!backend.supportsInvocation ||
				backend.supportsInvocation(invocation, protection) === true)
		);
	} catch {
		return false;
	}
};

export const fixedBash = (
	source: string,
	executable = "/bin/bash",
): ShellInvocation =>
	Object.freeze({
		kind: "source",
		executable,
		dialect: "bash",
		options: Object.freeze(["--noprofile", "--norc", "-c"]),
		source,
	});

export const platformShellSource = (source: string): ShellInvocation => {
	if (process.platform !== "win32") {
		const executable = resolveSystemBash();
		if (!executable) throw new Error("system_bash_unavailable");
		return fixedBash(source, executable);
	}
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !path.isAbsolute(systemRoot))
		throw new Error("windows_system_directory_unavailable");
	return Object.freeze({
		kind: "source",
		executable: path.join(
			systemRoot,
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		),
		dialect: "unsupported",
		options: Object.freeze([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
		]),
		source,
	});
};

const realOrLexical = (value: string): string => {
	try {
		return realpathSync(value);
	} catch {
		return path.resolve(value);
	}
};

// Resolve the nearest existing ancestor for a configured name that has not
// been created yet. Retain the original spelling for path-based backends.
export const resolvePolicyPath = (target: string): string => {
	const absolute = path.resolve(target);
	try {
		return realpathSync(absolute);
	} catch (error) {
		const parent = path.dirname(absolute);
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			parent === absolute
		)
			throw error;
		if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
			throw error;
		return path.join(resolvePolicyPath(parent), path.basename(absolute));
	}
};

export const canonicalPolicyPaths = (
	paths: readonly string[],
): readonly string[] =>
	Object.freeze([
		...new Set(
			paths.flatMap((entry) => [path.resolve(entry), resolvePolicyPath(entry)]),
		),
	]);

export const runtimeReadOnlyPaths = (): readonly string[] => {
	const storage = resolveStoragePaths();
	return canonicalPolicyPaths([
		storage.root,
		storage.configDir,
		storage.cacheDir,
		resolveConfigPath(),
	]);
};

const runtimeProtectedCredentialPaths = (): readonly string[] => {
	const storage = resolveStoragePaths();
	const targets: string[] = [];
	if (process.platform === "linux") {
		try {
			mkdirSync(storage.credentialsDir, { recursive: true, mode: 0o700 });
			targets.push(storage.credentialsDir);
		} catch {
			if (lstatSync(storage.credentialsDir, { throwIfNoEntry: false })) {
				targets.push(storage.credentialsDir);
			}
		}
		for (const legacy of [storage.legacyAuthFile, storage.legacyMcpAuthFile]) {
			if (lstatSync(legacy, { throwIfNoEntry: false })) {
				targets.push(legacy);
			}
		}
	} else {
		targets.push(
			storage.credentialsDir,
			storage.legacyAuthFile,
			storage.legacyMcpAuthFile,
		);
	}
	return canonicalPolicyPaths(targets);
};

const runtimeAuthorityAliasPaths = (): readonly string[] => {
	const storage = resolveStoragePaths();
	const databasePaths = [
		path.join(storage.configDir, ".projects-policy-lock.sqlite"),
		path.join(storage.sessionsDir, "state.db"),
	];
	return canonicalPolicyPaths([
		resolveConfigPath(),
		storage.configFile,
		storage.projectsFile,
		...[
			"launch-approvals",
			"auto-review.json",
			confinedAutoLaunchDirectoryName,
		].map((entry) => path.join(storage.configDir, entry)),
		...databasePaths.flatMap((file) =>
			["", "-wal", "-shm", "-journal"].map((suffix) => `${file}${suffix}`),
		),
	]);
};

export const workspacePathProtection = (
	root: string,
	extraProtectedPaths: readonly string[] = [],
	relatedDirectories: readonly string[] = [],
	sandboxMode: SandboxMode = "workspace-write",
	allowSharedGitObjects = false,
	extraReadOnlyPaths: readonly string[] = [],
	homeScope: {
		writeRoots?: readonly string[];
		recheckHomeLinksOnWrite?: true;
		/** Replace whole-directory Git protection with the Git write scope. */
		gitWrites?: true;
	} = {},
): Pick<
	ShellProtection,
	| "gitWriteRoots"
	| "gitProtectedPaths"
	| "protectedPaths"
	| "protectedAliasPaths"
	| "homeDotDirectory"
	| "readOnlyPaths"
	| "readOnlyAliasPaths"
	| "sharedGitObjectDirectories"
	| "verifiedGitHooks"
> => {
	const discover =
		allowSharedGitObjects &&
		sandboxMode === "workspace-write" &&
		!homeScope.gitWrites
			? gitMetadataWithObjectDirectories
			: gitMetadataPaths;
	const metadata = discover(root, ...relatedDirectories);
	const { reservedMarkers, objectDirectories, hookAliases } = metadata;
	const gitScope = homeScope.gitWrites
		? gitWriteScope(metadata.repositories)
		: undefined;
	const released = new Set(gitScope?.releasedPaths ?? []);
	const readOnlyPaths = gitScope
		? [
				...metadata.readOnlyPaths.filter((entry) => !released.has(entry)),
				...gitScope.readOnlyPaths,
			]
		: metadata.readOnlyPaths;
	const protectedPaths = canonicalPolicyPaths([
		...extraProtectedPaths,
		...runtimeProtectedCredentialPaths(),
	]);
	const projectConfig = workspaceConfigProtection(root);
	const hostReadOnlyPaths = canonicalPolicyPaths(extraReadOnlyPaths);
	const runtimeRoots = runtimeReadOnlyPaths();
	const runtimeAuthority = runtimeAuthorityAliasPaths();
	const protectedHome = homeDotDirectory(
		homeScope.writeRoots ?? (sandboxMode === "readonly" ? [] : [root]),
	);
	const additionalReadOnlyPaths = [
		...(protectedHome && !homeScope.recheckHomeLinksOnWrite
			? homeDotLinkTargets(protectedHome)
			: []),
		...reservedMarkers,
		...projectConfig.readOnlyPaths,
		...hostReadOnlyPaths,
		...runtimeRoots,
		...runtimeAuthority.filter(
			(target) =>
				!runtimeRoots.some((directory) => isWithin(directory, target)),
		),
	];
	const strongerPaths = [...protectedPaths, ...additionalReadOnlyPaths];
	const objectDirectoriesWithSharedFiles = objectDirectories.filter(
		(directory) => {
			const overlaps = (other: string) =>
				resourceContainsPath(other, directory.path) ||
				resourceContainsPath(directory.path, other);
			const commonDirectory = path.dirname(directory.path);
			return (
				!strongerPaths.some(overlaps) &&
				!readOnlyPaths.some(
					(other) =>
						overlaps(other) && realOrLexical(other) !== commonDirectory,
				)
			);
		},
	);
	// Git directories already inside a write root need no extra grant. A Git
	// directory under stronger protection is never opened for writes.
	const gitWriteRoots = (gitScope?.writeRoots ?? []).filter(
		(directory) =>
			directory !== path.parse(directory).root &&
			!(homeScope.writeRoots ?? []).some((root) => isWithin(root, directory)) &&
			!strongerPaths.some(
				(entry) => isWithin(entry, directory) || isWithin(directory, entry),
			),
	);
	return {
		...(protectedHome ? { homeDotDirectory: protectedHome } : {}),
		...(gitScope && gitScope.releasedPaths.length > 0
			? {
					...(gitWriteRoots.length ? { gitWriteRoots } : {}),
					gitProtectedPaths: gitScope.readOnlyPaths,
				}
			: {}),
		protectedPaths,
		protectedAliasPaths: protectedPaths,
		readOnlyPaths: Object.freeze(
			[...new Set([...readOnlyPaths, ...additionalReadOnlyPaths])].sort(),
		),
		readOnlyAliasPaths: Object.freeze([
			...new Set([
				...readOnlyPaths,
				...reservedMarkers,
				...projectConfig.readOnlyAliasPaths,
				...hostReadOnlyPaths,
				...runtimeAuthority,
			]),
		]),
		...(objectDirectoriesWithSharedFiles.length
			? {
					sharedGitObjectDirectories: Object.freeze(
						objectDirectoriesWithSharedFiles,
					),
					...(hookAliases.length ? { verifiedGitHooks: hookAliases } : {}),
				}
			: {}),
	};
};

const sbplString = (value: string): string => {
	if ([...value].some((character) => character < " " || character === "\x7f"))
		throw new Error("Unsupported control character in sandbox path");
	return JSON.stringify(value);
};

const subpaths = (paths: readonly string[]): string =>
	paths.map((entry) => `(subpath ${sbplString(entry)})`).join(" ");

// Renaming a writable ancestor could move a protected subtree out of the
// paths enforced by Seatbelt. Keep those directory entries in place.
export const protectedSeatbeltAncestors = (
	base: ShellProtection,
): readonly string[] => {
	const parents = new Set<string>();
	if (base.homeDotDirectory) parents.add(base.homeDotDirectory);
	for (const protectedPath of [
		...base.protectedPaths,
		...(base.readOnlyPaths ?? []),
		...(base.homeDotDirectory ? [base.homeDotDirectory] : []),
	]) {
		for (
			let child = protectedPath, parent = path.dirname(child);
			parent !== child;
			child = parent, parent = path.dirname(child)
		) {
			if (
				[...base.writeRoots, ...(base.gitWriteRoots ?? [])].some((root) =>
					isWithin(root, parent),
				)
			)
				parents.add(parent);
		}
	}
	return [...parents];
};

/**
 * Absent ancestors of `gitProtectedPaths` inside writable roots at admission
 * time. Seatbelt denies `file-write-create` on these literals so a confined
 * shell cannot plant a symlink (for example `.git/objects/info`) redirecting a
 * protected Git child without affecting ordinary workspace directories.
 */
export const absentProtectedSeatbeltAncestors = (
	base: ShellProtection,
): readonly string[] => {
	const gitProtected = base.gitProtectedPaths ?? [];
	if (!gitProtected.length) return [];
	const writableRoots = [...base.writeRoots, ...(base.gitWriteRoots ?? [])];
	const parents = new Set<string>();
	for (const protectedPath of gitProtected) {
		for (
			let child = protectedPath, parent = path.dirname(child);
			parent !== child;
			child = parent, parent = path.dirname(child)
		) {
			if (
				writableRoots.some((root) => isWithin(root, parent)) &&
				!lstatSync(parent, { throwIfNoEntry: false })
			)
				parents.add(parent);
		}
	}
	return [...parents];
};

const literal = (entry: string): string => `(literal ${sbplString(entry)})`;

// PTYs created inside the sandbox carry the sandbox PTY extension. Terminals
// that already existed (including the user's other terminals) only allow
// ioctl, so a command can detect a TTY without reading or writing them.
const pseudoTerminalRules = `(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all (regex #"^/dev/ttys[0-9]+$") (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))`;

const seatbeltProfile = (
	base: ShellProtection,
	scratch: string,
	mutation?: FixedFileMutationPaths,
): string => {
	const deviceAndIpcPaths = ["/dev", "/private/var/run"];
	const ancestorList = protectedSeatbeltAncestors({
		...base,
		protectedPaths: [...base.protectedPaths, ...deviceAndIpcPaths],
	});
	const ancestors = ancestorList.map(literal).join(" ");
	const absentAncestors = absentProtectedSeatbeltAncestors(base)
		.map(literal)
		.join(" ");
	const home = base.homeDotDirectory;
	// A literal prefix also reserves dot entries that do not exist at admission.
	const homeRule = home
		? `(deny file-write* (prefix ${sbplString(`${path.join(home, "/")}.`)}) ${subpaths([path.join(home, "Library")])})`
		: "";
	// An explicitly approved additional_write_root inside a home dot-directory
	// (other than home itself) may be re-opened before final readOnlyPaths/protectedPaths denies.
	const approvedHomeDotRoots =
		!mutation && home
			? base.writeRoots.filter(
					(root) => root !== home && isHomeDotTarget(home, root),
				)
			: [];
	const writeTrees = mutation
		? [scratch]
		: [scratch, ...base.writeRoots, ...(base.gitWriteRoots ?? [])];
	const fixedWriteRules =
		mutation &&
		[
			mutation.directories.length
				? `(allow file-write-create ${mutation.directories.map(literal).join(" ")})`
				: "",
			mutation.destination
				? `(allow file-write-create file-write-data file-write-mode ${literal(mutation.destination)})`
				: "",
			mutation.source
				? `(allow file-write-unlink ${literal(mutation.source)})`
				: "",
		].join("\n");
	return `
(version 1)
(deny default)
(allow process-exec process-fork)
(allow signal (target same-sandbox))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow sysctl-read)
(allow file-read*)
(allow file-write* ${subpaths(writeTrees)})
${fixedWriteRules ?? ""}
(deny file-read* file-write* ${subpaths(deviceAndIpcPaths)})
(allow file-read* (literal "/dev/null") (literal "/dev/zero")
  (literal "/dev/random") (literal "/dev/urandom"))
(allow file-write-data (literal "/dev/null"))
${mutation ? "" : pseudoTerminalRules}
${homeRule}
${approvedHomeDotRoots.length ? `(allow file-write* ${subpaths(approvedHomeDotRoots)})` : ""}
${base.protectedPaths.length ? `(deny file-read* file-write* ${subpaths(base.protectedPaths)})` : ""}
${base.readOnlyPaths?.length ? `(deny file-write* ${subpaths(base.readOnlyPaths)})` : ""}
${ancestors ? `(deny file-write-unlink ${ancestors})` : ""}
${absentAncestors ? `(deny file-write-create ${absentAncestors})` : ""}
(deny network*)
(deny file-write-setugid)
`;
};

const sandboxExec = "/usr/bin/sandbox-exec";

export const macAdditionalWriteLauncherPaths = (
	protection: ShellProtection,
): readonly string[] => {
	// A new writable root can change which helper passes launcher selection.
	// Preserve the baseline helper even when this runtime uses direct Seatbelt.
	const baseline = resolveMxcLauncher({
		...protection,
		writeRoots: [protection.root],
		homeDotDirectory: homeDotDirectory([protection.root]),
	});
	const selected = resolveMxcLauncher(protection);
	return [
		...new Set(
			[baseline, selected].flatMap((launcher) =>
				launcher ? [launcher.candidate, launcher.file] : [],
			),
		),
	];
};

export class MacSeatbeltBackend implements ProtectedShellBackend {
	readonly supportsReadOnlyPaths = true;
	readonly supportsHomeDotProtection = true;
	readonly supportsAbsentPathDenial = true;
	readonly supportsCommandBinding = true;
	private available: boolean | undefined;
	private mxcProbe?: { identity: string; available: boolean };

	constructor(private readonly launcher: "seatbelt" | "mxc" = "seatbelt") {}

	supports(protection: ShellProtection): boolean {
		return this.supportsPolicy(protection);
	}

	supportsFixedFileMutation(protection: ShellProtection): boolean {
		return this.supportsPolicy(protection, { directories: [] });
	}

	private supportsPolicy(
		protection: ShellProtection,
		mutation?: FixedFileMutationPaths,
	): boolean {
		if (process.platform !== "darwin" || protection.profile === "full-access")
			return false;
		if (
			protection.profile === "investigation" &&
			protection.writeRoots.length !== 0
		)
			return false;
		try {
			if (
				mutation &&
				(protection.profile !== "development" ||
					protection.stdin !== "pipe" ||
					[...mutation.directories, mutation.destination, mutation.source].some(
						(entry) =>
							entry !== undefined &&
							(!path.isAbsolute(entry) ||
								path.normalize(entry) !== entry ||
								!protection.writeRoots.some(
									(root) => entry !== root && isWithin(root, entry),
								)),
					))
			)
				return false;
			seatbeltProfile(protection, "/private/tmp/codelia-probe", mutation);
			if (
				findProtectedAliases(
					protection.protectedAliasPaths ?? protection.protectedPaths,
				).size > 0
			)
				return false;
			// Investigation has only fresh private scratch. Development checks
			// read-only aliases apart from the explicitly admitted Git storage.
			if (
				!mutation &&
				protection.writeRoots.length &&
				protection.readOnlyPaths?.length
			) {
				const sharedObjects = (protection.sharedGitObjectDirectories ?? []).map(
					(directory) => {
						if (
							gitObjectDirectoryIdentity(directory.path) !== directory.identity
						)
							throw new Error("unbound_git_object_directory");
						return directory.path;
					},
				);
				const aliasRoots = [
					...(protection.readOnlyAliasPaths ?? protection.readOnlyPaths),
					...sharedObjects.flatMap(gitObjectStoreConfigPaths),
				];
				if (
					hasReadOnlyAliases(
						aliasRoots,
						undefined,
						sharedObjects,
						protection.verifiedGitHooks,
					)
				)
					return false;
			}
		} catch {
			return false;
		}
		if (this.launcher === "mxc") {
			const helper = resolveMxcLauncher(protection);
			if (!helper) return false;
			if (helper.identity !== this.mxcProbe?.identity) {
				this.mxcProbe = {
					identity: helper.identity,
					available: probeMxcLauncher(helper),
				};
			}
			return this.mxcProbe.available;
		}
		if (this.available === undefined) {
			const check = spawnSync(
				sandboxExec,
				[
					"-p",
					seatbeltProfile(
						{
							...protection,
							writeRoots: [],
							protectedPaths: [],
							readOnlyPaths: [],
						},
						"/private/tmp/codelia-probe",
					),
					"/usr/bin/true",
				],
				{ env: {}, stdio: "ignore", timeout: 1500 },
			);
			this.available = check.status === 0;
		}
		return this.available;
	}

	supportsLaunchBinding(candidate: LaunchRuleCandidate): boolean {
		return candidate.rule.template === "bun-typecheck/v1";
	}

	get exactLaunchBindingId(): string {
		return `codelia.macos.${this.launcher}/v2`;
	}

	supportsExactLaunchBinding(_candidate: ExactLaunchCandidate): boolean {
		return true;
	}

	launch(invocation: ShellInvocation, protection: ShellProtection): ShellChild {
		return this.launchWithPolicy(invocation, protection);
	}

	launchFixedFileMutation(
		protection: ShellProtection,
		mutation: DirectoryMutation,
	): ShellChild {
		const { invocation, paths } = fixedFileMutation(mutation);
		return this.launchWithPolicy(invocation, protection, paths);
	}

	private launchWithPolicy(
		invocation: ShellInvocation,
		protection: ShellProtection,
		mutation?: FixedFileMutationPaths,
	): ShellChild {
		if (
			!(mutation
				? this.supportsPolicy(protection, mutation)
				: this.supports(protection))
		)
			throw new Error("sandbox_unavailable");
		const scratch = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), "codelia-shell-")),
		);
		const cleanup = () => {
			try {
				rmSync(scratch, { recursive: true, force: true });
			} catch {
				// Only this launch's private directory is eligible for cleanup.
			}
		};
		try {
			const profile = seatbeltProfile(protection, scratch, mutation);
			const argv = shellInvocationArgs(invocation);
			if (this.launcher === "mxc") {
				const helper = resolveMxcLauncher(protection);
				if (!helper || helper.identity !== this.mxcProbe?.identity)
					throw new Error("sandbox_unavailable");
				const child = launchMxc(
					helper,
					{
						executable: invocation.executable,
						args: argv,
						cwd: protection.cwd,
						profile,
						scratch,
						path: shellPathForLaunch(protection.binPaths),
						home: os.homedir(),
						cargo_home: protection.toolchainHomes?.CARGO_HOME,
						rustup_home: protection.toolchainHomes?.RUSTUP_HOME,
					},
					protection.stdin,
				);
				child.once("close", cleanup);
				return child;
			}
			const child = spawn(
				sandboxExec,
				["-p", profile, invocation.executable, ...argv],
				{
					cwd: protection.cwd,
					env: {
						PATH: shellPathForLaunch(protection.binPaths),
						LANG: "C",
						HOME: os.homedir(),
						TMPDIR: scratch,
						XDG_CACHE_HOME: scratch,
						GIT_OPTIONAL_LOCKS: "0",
						...protection.toolchainHomes,
					},
					stdio: [
						protection.stdin === "pipe" ? "pipe" : "ignore",
						"pipe",
						"pipe",
					],
					detached: true,
				},
			) as ShellChild;
			child.once("close", cleanup);
			return child;
		} catch (error) {
			cleanup();
			throw error;
		}
	}
}

/** Explicit SDK opt-in for the qualified macOS arm64 helper. */
export const createMacMxcShellBackend = (): ProtectedShellBackend =>
	new MacSeatbeltBackend("mxc");

const SCRUBBED_LOGIN_ENV_KEYS = new Set([
	"BASH_ENV",
	"ENV",
	"SHELLOPTS",
	"BASHOPTS",
	"PS4",
	"PROMPT_COMMAND",
	"CDPATH",
	"GLOBIGNORE",
	"FPATH",
	"ZDOTDIR",
	"IFS",
	"NODE_OPTIONS",
	"PYTHONSTARTUP",
	"PERL5OPT",
	"RUBYOPT",
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
]);

/**
 * The runtime environment for a login-user launch. Strips shell startup,
 * command-resolution, interpreter-option, and dynamic-loader injection hooks
 * (which could also enter process.env via Bun's automatic .env loading) so
 * UserShellBackend preserves supportsCommandBinding.
 */
export const loginUserEnvironment = (
	sourceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(sourceEnv)) {
		if (value === undefined) continue;
		if (
			SCRUBBED_LOGIN_ENV_KEYS.has(key) ||
			key.startsWith("BASH_FUNC_") ||
			key.startsWith("LD_") ||
			key.startsWith("DYLD_")
		)
			continue;
		env[key] = value;
	}
	return env;
};

/**
 * Only the admission layer can select a login-user launch. No OS constraints
 * are applied, so the child inherits the scrubbed login environment like any
 * other process started by the user.
 */
export class UserShellBackend implements ProtectedShellBackend {
	readonly supportsCommandBinding = true;

	supports(protection: ShellProtection): boolean {
		return protection.profile === "full-access";
	}

	launch(invocation: ShellInvocation, protection: ShellProtection): ShellChild {
		if (!this.supports(protection)) throw new Error("sandbox_unavailable");
		return spawn(invocation.executable, shellInvocationArgs(invocation), {
			cwd: protection.cwd,
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
			env: {
				...loginUserEnvironment(),
				PATH: shellPathForLaunch(protection.binPaths),
				HOME: os.homedir(),
				TMPDIR: os.tmpdir(),
				LANG: "C",
				...protection.toolchainHomes,
				...(process.platform === "win32" && {
					SystemRoot: process.env.SystemRoot,
					USERPROFILE: os.homedir(),
					TEMP: os.tmpdir(),
					TMP: os.tmpdir(),
				}),
			},
			stdio: [protection.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
		}) as ShellChild;
	}
}

let standardMacBackend: MacSeatbeltBackend | undefined;
let explicitMacMxcBackend: ProtectedShellBackend | undefined;
let standardLinuxBackend: LinuxRunscBackend | undefined;

/** Selection alone provides no guarantee that a particular profile can launch. */
export const selectProtectedShellBackend = ({
	platform = process.platform,
	allowStandard,
	adapter,
	macBackend = "seatbelt",
}: {
	platform?: NodeJS.Platform;
	allowStandard: boolean;
	adapter?: ProtectedShellBackend;
	macBackend?: "seatbelt" | "mxc";
}): ProtectedShellBackend | undefined => {
	if (adapter) return adapter;
	if (!allowStandard) return undefined;
	if (platform === "linux") {
		standardLinuxBackend ??= new LinuxRunscBackend();
		return standardLinuxBackend;
	}
	if (platform === "darwin") {
		if (macBackend === "mxc") {
			explicitMacMxcBackend ??= createMacMxcShellBackend();
			return explicitMacMxcBackend;
		}
		standardMacBackend ??= new MacSeatbeltBackend();
		return standardMacBackend;
	}
	// MXC 1.1.0 ProcessContainer can inherit host ACL grants to
	// ALL_APPLICATION_PACKAGES independently of the requested policy.
	return undefined;
};

export const directoryIdentity = (directory: string): string => {
	const stat = statSync(directory, { bigint: true });
	if (!stat.isDirectory()) throw new Error("invalid_working_directory");
	return `${stat.dev}:${stat.ino}`;
};
