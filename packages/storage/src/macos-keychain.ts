import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CODELIA_AUTH_KEYCHAIN_SERVICE = "codelia.auth";
export const CODELIA_MCP_AUTH_KEYCHAIN_SERVICE = "codelia.mcp-auth";

const HELPER_BINARY_NAME = "codelia-credential-helper";
const DEFAULT_ASYNC_TIMEOUT_MS = 5_000;
const DEFAULT_SYNC_TIMEOUT_MS = 2_000;
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

export class KeychainError extends Error {
	readonly code: "keychain_locked" | "keychain_unavailable" | "keychain_error";

	constructor(
		code: "keychain_locked" | "keychain_unavailable" | "keychain_error",
		message: string,
	) {
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

const isTrustedExecutable = (candidate: string, uid: bigint): string | null => {
	try {
		const directory = realpathSync(path.dirname(candidate));
		const file = path.join(directory, path.basename(candidate));
		const info = lstatSync(file, { bigint: true });
		if (
			!info.isFile() ||
			info.nlink !== 1n ||
			info.size === 0n ||
			(info.uid !== uid && info.uid !== 0n) ||
			(info.mode & 0o6022n) !== 0n ||
			(info.mode & 0o100n) === 0n
		) {
			return null;
		}
		let current = directory;
		for (;;) {
			const parent = statSync(current, { bigint: true });
			const systemSticky = parent.uid === 0n && (parent.mode & 0o1000n) !== 0n;
			if (
				!parent.isDirectory() ||
				(parent.uid !== uid && parent.uid !== 0n) ||
				((parent.mode & 0o022n) !== 0n && !systemSticky)
			) {
				return null;
			}
			const next = path.dirname(current);
			if (next === current) break;
			current = next;
		}
		return file;
	} catch {
		return null;
	}
};

/**
 * Resolve the trusted macOS `codelia-credential-helper` binary from the repo
 * checkout or the installed `@codelia/tui-darwin-*` package. Never consults
 * project cwd or command PATH.
 */
export const resolveMacOsCredentialHelper = (
	overridePath?: string,
): string | null => {
	if (process.platform !== "darwin") return null;
	const uid = process.geteuid?.();
	if (uid === undefined) return null;
	const bigUid = BigInt(uid);

	if (overridePath) {
		return isTrustedExecutable(overridePath, bigUid);
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
		let dir = actualModule;
		for (;;) {
			const candidatePkg = path.join(
				dir,
				"node_modules",
				...pkgName.split("/"),
			);
			const installedVersion = packageVersion(candidatePkg, pkgName);
			if (
				installedVersion &&
				(!storageVersion || installedVersion === storageVersion)
			) {
				const bin = isTrustedExecutable(
					path.join(candidatePkg, "bin", HELPER_BINARY_NAME),
					bigUid,
				);
				if (bin) return bin;
			}
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {
		return null;
	}
	return null;
};

type HelperResponse =
	| {
			ok: true;
			status?: string;
			found?: boolean;
			value?: string;
			deleted?: boolean;
	  }
	| { ok: false; code?: string; message?: string };

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
	return new KeychainError(
		"keychain_error",
		resp.message ?? "macOS Keychain operation failed",
	);
};

export class MacOsKeychainClient implements KeychainClient {
	private readonly helperOverride?: string;

	constructor(options?: { helperPath?: string }) {
		this.helperOverride = options?.helperPath;
	}

	private helperPath(): string | null {
		return resolveMacOsCredentialHelper(this.helperOverride);
	}

	private callAsync(
		request: Record<string, unknown>,
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<HelperResponse> {
		const bin = this.helperPath();
		if (!bin) {
			return Promise.resolve({
				ok: false,
				code: "unavailable",
				message:
					process.platform !== "darwin"
						? "unsupported_platform"
						: "codelia-credential-helper binary not found",
			});
		}
		return new Promise((resolve, reject) => {
			const child = execFile(
				bin,
				[],
				{
					timeout: timeoutMs,
					maxBuffer: MAX_HELPER_BUFFER,
					encoding: "utf8",
				},
				(error, stdout) => {
					if (stdout?.trim()) {
						try {
							resolve(JSON.parse(stdout.trim()) as HelperResponse);
							return;
						} catch {
							// Fall through to error handling.
						}
					}
					if (error) {
						reject(
							new KeychainError(
								"keychain_error",
								`credential helper failed: ${error.message}`,
							),
						);
						return;
					}
					reject(
						new KeychainError(
							"keychain_error",
							"credential helper returned empty response",
						),
					);
				},
			);
			child.stdin?.end(JSON.stringify(request));
		});
	}

	private callSync(
		request: Record<string, unknown>,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): HelperResponse {
		const bin = this.helperPath();
		if (!bin) {
			return {
				ok: false,
				code: "unavailable",
				message:
					process.platform !== "darwin"
						? "unsupported_platform"
						: "codelia-credential-helper binary not found",
			};
		}
		try {
			const stdout = execFileSync(bin, [], {
				input: JSON.stringify(request),
				timeout: timeoutMs,
				maxBuffer: MAX_HELPER_BUFFER,
				encoding: "utf8",
			});
			return JSON.parse(stdout.trim()) as HelperResponse;
		} catch (error) {
			throw new KeychainError(
				"keychain_error",
				error instanceof Error
					? `credential helper failed: ${error.message}`
					: "credential helper failed",
			);
		}
	}

	async probe(): Promise<KeychainProbeResult> {
		if (process.platform !== "darwin") {
			return {
				available: false,
				reason: "unsupported_platform",
				message: "OS Keychain backend is currently supported on macOS only",
			};
		}
		const bin = this.helperPath();
		if (!bin) {
			return {
				available: false,
				reason: "keychain_unavailable",
				message: "codelia-credential-helper binary is not installed",
			};
		}
		try {
			const resp = await this.callAsync({ op: "probe" });
			if (resp.ok) return { available: true };
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
		const resp = await this.callAsync({ op: "get", service, account });
		if (!resp.ok) throw toKeychainError(resp);
		return resp.found ? (resp.value ?? "") : null;
	}

	getSync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): string | null {
		const resp = this.callSync({ op: "get", service, account }, timeoutMs);
		if (!resp.ok) throw toKeychainError(resp);
		return resp.found ? (resp.value ?? "") : null;
	}

	async set(service: string, account: string, value: string): Promise<void> {
		const resp = await this.callAsync({ op: "set", service, account, value });
		if (!resp.ok) throw toKeychainError(resp);
	}

	async delete(service: string, account: string): Promise<boolean> {
		const resp = await this.callAsync({ op: "delete", service, account });
		if (!resp.ok) throw toKeychainError(resp);
		return resp.deleted === true;
	}
}
