import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStoragePaths } from "./paths";

export const CODELIA_AUTH_KEYCHAIN_SERVICE = "codelia.auth";
export const CODELIA_MCP_AUTH_KEYCHAIN_SERVICE = "codelia.mcp-auth";

const HELPER_BINARY_NAME = "codelia-credential-helper";
const MAX_HELPER_EXECUTABLE_BYTES = 16 * 1024 * 1024;
declare const __CODELIA_CREDENTIAL_HELPER_SHA256__: Partial<
	Record<string, string>
>;
const DEFAULT_ASYNC_TIMEOUT_MS = 5_000;
const DEFAULT_SYNC_TIMEOUT_MS = 2_000;
const AUTHORIZATION_TIMEOUT_MS = 120_000;
const MAX_HELPER_BUFFER = 8 * 1024 * 1024;

export type KeychainProbeResult =
	| { available: true }
	| {
			available: false;
			reason:
				| "unsupported_platform"
				| "keychain_locked"
				| "keychain_unavailable";
			message: string;
	  };

type KeychainErrorCode =
	| "keychain_locked"
	| "keychain_access_denied"
	| "keychain_unavailable"
	| "keychain_error";

export class KeychainError extends Error {
	readonly code: KeychainErrorCode;

	constructor(code: KeychainErrorCode, message: string) {
		super(message);
		this.name = "KeychainError";
		this.code = code;
	}
}

export interface KeychainClient {
	probe(): Promise<KeychainProbeResult>;
	get(service: string, account: string): Promise<string | null>;
	getSync(service: string, account: string, timeoutMs?: number): string | null;
	set(service: string, account: string, value: string): Promise<void>;
	delete(service: string, account: string): Promise<boolean>;
}

const canonicalDirForHash = (configDir: string): string => {
	const resolved = path.resolve(configDir);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
};

export const keychainAccountForConfigDir = (configDir: string): string => {
	const digest = createHash("sha256")
		.update(canonicalDirForHash(configDir))
		.digest("hex")
		.slice(0, 16);
	return `codelia-${digest}`;
};

const moduleDir =
	typeof __dirname === "string"
		? __dirname
		: path.dirname(fileURLToPath(import.meta.url));

const packageVersion = (
	directory: string,
	name: string,
): string | undefined => {
	try {
		const manifest = path.join(directory, "package.json");
		const info = lstatSync(manifest);
		if (!info.isFile() || info.size > 64 * 1024) return undefined;
		const parsed = JSON.parse(readFileSync(manifest, "utf8"));
		return parsed.name === name && typeof parsed.version === "string"
			? parsed.version
			: undefined;
	} catch {
		return undefined;
	}
};

const directoryId = (info: { dev: bigint; ino: bigint }): string =>
	`${info.dev}:${info.ino}`;

export type TrustedCredentialHelper = {
	file: string;
	identity: string;
};

/**
 * Default agent-writable roots that must never contain a trusted credential
 * helper binary (matches `mxc-launcher.ts` writable-ancestor exclusion).
 */
export const defaultUntrustedHelperRoots = (): string[] => {
	const roots: string[] = [];
	const cwd = process.cwd();
	if (cwd) roots.push(cwd);
	const sandboxRoot = process.env.CODELIA_SANDBOX_ROOT?.trim();
	if (sandboxRoot) roots.push(sandboxRoot);
	return roots;
};

const collectMutableDirIds = (roots: readonly string[]): Set<string> => {
	const ids = new Set<string>();
	for (const root of roots) {
		if (!root) continue;
		try {
			ids.add(directoryId(statSync(realpathSync(root), { bigint: true })));
		} catch {
			// Non-existent root cannot be an ancestor of an existing executable.
		}
	}
	return ids;
};

const isTrustedDirectory = (
	directory: string,
	uid: bigint,
	mutableDirs: ReadonlySet<string>,
): boolean => {
	let current = directory;
	for (;;) {
		const parent = statSync(current, { bigint: true });
		const systemSticky = parent.uid === 0n && (parent.mode & 0o1000n) !== 0n;
		if (
			!parent.isDirectory() ||
			mutableDirs.has(directoryId(parent)) ||
			(parent.uid !== uid && parent.uid !== 0n) ||
			((parent.mode & 0o022n) !== 0n && !systemSticky)
		) {
			return false;
		}
		const next = path.dirname(current);
		if (next === current) return true;
		current = next;
	}
};

const hasTrustedExecutableMode = (info: BigIntStats, uid: bigint): boolean =>
	info.isFile() &&
	info.size > 0n &&
	(info.uid === uid || info.uid === 0n) &&
	(info.mode & 0o6022n) === 0n &&
	(info.mode & 0o100n) !== 0n;

const isTrustedExecutable = (
	candidate: string,
	uid: bigint,
	mutableDirs: ReadonlySet<string>,
): TrustedCredentialHelper | null => {
	try {
		const directory = realpathSync(path.dirname(candidate));
		const file = path.join(directory, path.basename(candidate));
		const info = lstatSync(file, { bigint: true });
		if (
			!hasTrustedExecutableMode(info, uid) ||
			info.nlink !== 1n ||
			!isTrustedDirectory(directory, uid, mutableDirs)
		) {
			return null;
		}
		return {
			file,
			identity: executableId(info),
		};
	} catch {
		return null;
	}
};

const executableId = (info: BigIntStats): string =>
	`${directoryId(info)}:${info.size}:${info.ctimeNs}`;

const readVerifiedExecutable = (
	candidate: string,
	digest: string,
	uid: bigint,
	mutableDirs: ReadonlySet<string>,
): {
	bytes: Buffer;
	helper: TrustedCredentialHelper;
	info: BigIntStats;
} | null => {
	const directory = realpathSync(path.dirname(candidate));
	if (!isTrustedDirectory(directory, uid, mutableDirs)) return null;
	const file = path.join(directory, path.basename(candidate));
	const fd = openSync(
		file,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const info = fstatSync(fd, { bigint: true });
		if (
			!hasTrustedExecutableMode(info, uid) ||
			info.size > MAX_HELPER_EXECUTABLE_BYTES
		)
			return null;
		const bytes = Buffer.alloc(Number(info.size));
		let offset = 0;
		while (offset < bytes.length) {
			const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
			if (read === 0) return null;
			offset += read;
		}
		const identity = executableId(info);
		if (
			createHash("sha256").update(bytes).digest("hex") !== digest ||
			executableId(lstatSync(file, { bigint: true })) !== identity
		) {
			return null;
		}
		return { bytes, helper: { file, identity }, info };
	} finally {
		closeSync(fd);
	}
};

const canonicalProspectiveDirectory = (directory: string) => {
	const absolute = path.resolve(directory);
	let ancestor = absolute;
	while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
		ancestor = path.dirname(ancestor);
	}
	const canonicalAncestor = realpathSync(ancestor);
	return {
		ancestor: canonicalAncestor,
		directory: path.join(canonicalAncestor, path.relative(ancestor, absolute)),
	};
};

const verifyPackagedCredentialHelper = (
	candidate: string,
	digest: string,
	uid: bigint,
	mutableDirs: ReadonlySet<string>,
	options: ResolveHelperOptions,
): TrustedCredentialHelper | null => {
	const source = readVerifiedExecutable(candidate, digest, uid, mutableDirs);
	if (!source) return null;

	// The package-manager store shares the source inode with other installs.
	// Prefer a previously prepared copy even if the package store later unlinks
	// its own inode reference. Keychain can keep using the same executable path.
	const credentialsDir = path.resolve(
		options.credentialsDir ?? resolveStoragePaths().credentialsDir,
	);
	const destination = path.join(credentialsDir, `keychain-helper-${digest}`);
	if (!lstatSync(destination, { throwIfNoEntry: false })) {
		if (source.info.nlink === 1n) return source.helper;
		if (options.stagePackagedHelper === false) return null;

		const prospective = canonicalProspectiveDirectory(credentialsDir);
		if (!isTrustedDirectory(prospective.ancestor, uid, mutableDirs)) {
			return null;
		}
		for (const root of options.untrustedRoots ??
			defaultUntrustedHelperRoots()) {
			if (!root) continue;
			const canonicalRoot = canonicalProspectiveDirectory(root).directory;
			const relative = path.relative(canonicalRoot, prospective.directory);
			if (relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
				return null;
			}
		}
		mkdirSync(prospective.directory, { recursive: true, mode: 0o700 });
		if (
			!isPrivateDirectory(credentialsDir, uid) ||
			realpathSync(credentialsDir) !== prospective.directory ||
			!isTrustedDirectory(prospective.directory, uid, mutableDirs)
		) {
			return null;
		}
		const staging = mkdtempSync(path.join(credentialsDir, ".keychain-helper-"));
		try {
			writeFileSync(path.join(staging, HELPER_BINARY_NAME), source.bytes, {
				flag: "wx",
				mode: 0o500,
			});
			try {
				renameSync(staging, destination);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	if (
		!isPrivateDirectory(credentialsDir, uid) ||
		!isPrivateDirectory(destination, uid)
	) {
		return null;
	}
	const copy = readVerifiedExecutable(
		path.join(destination, HELPER_BINARY_NAME),
		digest,
		uid,
		mutableDirs,
	);
	return copy &&
		copy.info.nlink === 1n &&
		copy.info.uid === uid &&
		(copy.info.mode & 0o777n) === 0o500n
		? copy.helper
		: null;
};

const isPrivateDirectory = (directory: string, uid: bigint): boolean => {
	const info = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
	return (
		!!info?.isDirectory() && info.uid === uid && (info.mode & 0o077n) === 0n
	);
};

export type ResolveHelperOptions = {
	overridePath?: string;
	credentialsDir?: string;
	/** Status inspection can use an existing verified copy without creating one. */
	stagePackagedHelper?: boolean;
	/**
	 * Writable workspace/sandbox directories whose descendants must NOT be
	 * trusted as a host-privileged credential helper. Defaults to
	 * `defaultUntrustedHelperRoots()` (`cwd` and `CODELIA_SANDBOX_ROOT`).
	 */
	untrustedRoots?: readonly string[];
};

const normalizeResolveOptions = (
	input?: string | ResolveHelperOptions,
): ResolveHelperOptions =>
	typeof input === "string" ? { overridePath: input } : (input ?? {});

/**
 * Resolve the trusted macOS `codelia-credential-helper` binary along with its
 * file identity (`dev:ino:size:ctimeNs`). Excludes any binary located under
 * writable workspace/sandbox ancestors and never consults cwd or command PATH.
 */
export const resolveTrustedMacOsCredentialHelper = (
	input?: string | ResolveHelperOptions,
): TrustedCredentialHelper | null => {
	if (process.platform !== "darwin") return null;
	const uid = process.geteuid?.();
	if (uid === undefined) return null;
	const bigUid = BigInt(uid);
	const options = normalizeResolveOptions(input);
	const mutableDirs = collectMutableDirIds(
		options.untrustedRoots ?? defaultUntrustedHelperRoots(),
	);

	if (options.overridePath) {
		return isTrustedExecutable(options.overridePath, bigUid, mutableDirs);
	}

	try {
		const actualModule = realpathSync(moduleDir);
		const pkgRoot =
			path.basename(actualModule) === "src" ||
			path.basename(actualModule) === "dist"
				? path.dirname(actualModule)
				: actualModule;

		// Repo checkout development layout: packages/storage -> crates/credential-helper
		const storageSuffix = path.join("packages", "storage");
		if (pkgRoot.endsWith(`${path.sep}${storageSuffix}`)) {
			const repoRoot = path.resolve(pkgRoot, "../..");
			const checkoutBin = isTrustedExecutable(
				path.join(
					repoRoot,
					"crates",
					"credential-helper",
					"target",
					"release",
					HELPER_BINARY_NAME,
				),
				bigUid,
				mutableDirs,
			);
			if (checkoutBin) return checkoutBin;
		}

		// Installed npm package layout
		const pkgName =
			process.arch === "arm64"
				? "@codelia/tui-darwin-arm64"
				: process.arch === "x64"
					? "@codelia/tui-darwin-x64"
					: null;
		if (!pkgName) return null;
		const storageVersion = packageVersion(pkgRoot, "@codelia/storage");
		if (!storageVersion) return null;
		const require = createRequire(path.join(pkgRoot, "package.json"));
		const candidatePkg = path.dirname(
			require.resolve(`${pkgName}/package.json`),
		);
		if (packageVersion(candidatePkg, pkgName) !== storageVersion) return null;
		const candidate = path.join(candidatePkg, "bin", HELPER_BINARY_NAME);
		const digest =
			typeof __CODELIA_CREDENTIAL_HELPER_SHA256__ === "undefined"
				? undefined
				: __CODELIA_CREDENTIAL_HELPER_SHA256__[process.arch];
		// Local builds can use a trusted single-link helper. A shared inode
		// always needs the release digest and a private executable copy.
		if (digest === undefined) {
			return isTrustedExecutable(candidate, bigUid, mutableDirs);
		}
		return /^[a-f0-9]{64}$/.test(digest)
			? verifyPackagedCredentialHelper(
					candidate,
					digest,
					bigUid,
					mutableDirs,
					options,
				)
			: null;
	} catch {
		return null;
	}
};

/**
 * Resolve the trusted macOS `codelia-credential-helper` path, or null when
 * unavailable or located inside an agent-writable workspace.
 */
export const resolveMacOsCredentialHelper = (
	input?: string | ResolveHelperOptions,
): string | null => resolveTrustedMacOsCredentialHelper(input)?.file ?? null;

type HelperResponse =
	| {
			ok: true;
			status?: string;
			found?: boolean;
			authorized?: boolean;
			value?: string;
			deleted?: boolean;
	  }
	| { ok: false; code?: string; message?: string };

const parseHelperResponse = (stdout: string): HelperResponse => {
	try {
		const parsed = JSON.parse(stdout) as HelperResponse;
		if (
			parsed?.ok === true ||
			(parsed?.ok === false &&
				(parsed.code === undefined || typeof parsed.code === "string") &&
				(parsed.message === undefined || typeof parsed.message === "string"))
		)
			return parsed;
	} catch {
		// Parser errors can embed the credential data returned by the helper.
	}
	throw new KeychainError(
		"keychain_error",
		"credential helper returned an invalid response",
	);
};

const toKeychainError = (resp: {
	code?: string;
	message?: string;
}): KeychainError => {
	if (resp.code === "locked") {
		return new KeychainError(
			"keychain_locked",
			resp.message ??
				"macOS login Keychain is locked; run `security unlock-keychain ~/Library/Keychains/login.keychain-db`",
		);
	}
	if (resp.code === "unavailable") {
		return new KeychainError(
			"keychain_unavailable",
			resp.message ?? "macOS Keychain helper is unavailable",
		);
	}
	if (resp.code === "access_denied") {
		return new KeychainError(
			"keychain_access_denied",
			resp.message ??
				"macOS Keychain denied access; run `codelia auth authorize-keychain` from a local terminal",
		);
	}
	return new KeychainError(
		"keychain_error",
		resp.message ?? "macOS Keychain operation failed",
	);
};

export class MacOsKeychainClient implements KeychainClient {
	private pinnedHelper: TrustedCredentialHelper | null = null;

	constructor(
		private readonly options?: Omit<ResolveHelperOptions, "overridePath"> & {
			helperPath?: string;
		},
	) {}

	private resolveVerifiedHelper(): TrustedCredentialHelper | null {
		if (
			!this.options?.helperPath &&
			process.env.CODELIA_TEST_KEYCHAIN_DISABLED === "1"
		) {
			throw new KeychainError(
				"keychain_unavailable",
				"the native Keychain helper is disabled for tests",
			);
		}
		const resolved = resolveTrustedMacOsCredentialHelper({
			...this.options,
			overridePath: this.options?.helperPath,
		});
		if (!resolved) return null;
		if (
			this.pinnedHelper &&
			(this.pinnedHelper.file !== resolved.file ||
				this.pinnedHelper.identity !== resolved.identity)
		) {
			throw new KeychainError(
				"keychain_error",
				"codelia-credential-helper binary identity changed after verification",
			);
		}
		this.pinnedHelper = resolved;
		return resolved;
	}

	private async callAsync(
		request: Record<string, unknown>,
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<HelperResponse> {
		const helper = this.resolveVerifiedHelper();
		if (!helper) {
			return {
				ok: false,
				code: "unavailable",
				message:
					process.platform !== "darwin"
						? "unsupported_platform"
						: this.options?.stagePackagedHelper === false
							? "codelia-credential-helper is unavailable or its private copy has not been prepared"
							: "codelia-credential-helper binary not found or untrusted",
			};
		}
		return new Promise((resolve, reject) => {
			const child = execFile(
				helper.file,
				[],
				{
					cwd: "/private/tmp",
					env: {},
					timeout: timeoutMs,
					maxBuffer: MAX_HELPER_BUFFER,
					encoding: "utf8",
				},
				(error, stdout) => {
					if (error) {
						reject(
							new KeychainError(
								"keychain_error",
								error.killed && error.code === null
									? "credential helper timed out"
									: "credential helper failed",
							),
						);
						return;
					}
					try {
						resolve(parseHelperResponse(stdout));
					} catch (failure) {
						reject(failure);
					}
				},
			);
			// The exec callback reports child failures. A child that exits before
			// reading the request can also close the stdin pipe while we write it.
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(JSON.stringify(request));
		});
	}

	private callSync(
		request: Record<string, unknown>,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): HelperResponse {
		const helper = this.resolveVerifiedHelper();
		if (!helper) {
			return {
				ok: false,
				code: "unavailable",
				message:
					process.platform !== "darwin"
						? "unsupported_platform"
						: "codelia-credential-helper binary not found or untrusted",
			};
		}
		let stdout: string;
		try {
			stdout = execFileSync(helper.file, [], {
				cwd: "/private/tmp",
				env: {},
				input: JSON.stringify(request),
				stdio: "pipe",
				timeout: timeoutMs,
				maxBuffer: MAX_HELPER_BUFFER,
				encoding: "utf8",
			});
		} catch {
			// Child process errors can contain raw stdout and stderr.
			throw new KeychainError("keychain_error", "credential helper failed");
		}
		return parseHelperResponse(stdout);
	}

	async probe(): Promise<KeychainProbeResult> {
		if (process.platform !== "darwin") {
			return {
				available: false,
				reason: "unsupported_platform",
				message: "OS Keychain backend is currently supported on macOS only",
			};
		}
		try {
			const resp = await this.callAsync({ op: "probe" });
			if (resp.ok) {
				if (resp.status === "available") return { available: true };
				return {
					available: false,
					reason: "keychain_unavailable",
					message: "credential helper returned an invalid probe response",
				};
			}
			if (resp.code === "locked") {
				return {
					available: false,
					reason: "keychain_locked",
					message:
						resp.message ??
						"macOS login Keychain is locked; run `security unlock-keychain ~/Library/Keychains/login.keychain-db`",
				};
			}
			return {
				available: false,
				reason: "keychain_unavailable",
				message: resp.message ?? "macOS Keychain is unavailable",
			};
		} catch (error) {
			return {
				available: false,
				reason: "keychain_unavailable",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async get(service: string, account: string): Promise<string | null> {
		return readHelperValue(
			await this.callAsync({ op: "get", service, account }),
		);
	}

	/** For explicit local user actions. The helper discards any credential data. */
	async authorize(service: string, account: string): Promise<boolean> {
		const found = await this.requestAuthorization(service, account, true);
		if (!found) return false;
		// A separate noninteractive process verifies that the grant survives the prompt.
		try {
			return await this.requestAuthorization(service, account, false);
		} catch (error) {
			if (
				error instanceof KeychainError &&
				error.code === "keychain_access_denied"
			) {
				throw new KeychainError(
					"keychain_access_denied",
					"Run `codelia auth authorize-keychain` again and choose Always Allow to save authorization for this helper.",
				);
			}
			throw error;
		}
	}

	private async requestAuthorization(
		service: string,
		account: string,
		allowPrompt: boolean,
	): Promise<boolean> {
		const resp = await this.callAsync(
			{ op: "authorize", service, account, allow_prompt: allowPrompt },
			allowPrompt ? AUTHORIZATION_TIMEOUT_MS : DEFAULT_ASYNC_TIMEOUT_MS,
		);
		if (!resp.ok) throw toKeychainError(resp);
		if (
			resp.authorized !== true ||
			typeof resp.found !== "boolean" ||
			"value" in resp
		) {
			throw new KeychainError(
				"keychain_error",
				"credential helper returned an invalid authorization response",
			);
		}
		return resp.found;
	}

	getSync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): string | null {
		return readHelperValue(
			this.callSync({ op: "get", service, account }, timeoutMs),
		);
	}

	async set(service: string, account: string, value: string): Promise<void> {
		const resp = await this.callAsync({ op: "set", service, account, value });
		if (!resp.ok) throw toKeychainError(resp);
	}

	async delete(service: string, account: string): Promise<boolean> {
		const resp = await this.callAsync({ op: "delete", service, account });
		if (!resp.ok) throw toKeychainError(resp);
		if (typeof resp.deleted === "boolean") return resp.deleted;
		throw new KeychainError(
			"keychain_error",
			"credential helper returned an invalid delete response",
		);
	}
}

const readHelperValue = (response: HelperResponse): string | null => {
	if (!response.ok) throw toKeychainError(response);
	if (response.found === false) return null;
	if (response.found === true && typeof response.value === "string") {
		return response.value;
	}
	throw new KeychainError(
		"keychain_error",
		"credential helper returned an invalid read response",
	);
};
