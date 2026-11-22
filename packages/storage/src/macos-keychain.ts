import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODELIA_AUTH_KEYCHAIN_SERVICE = "codelia.auth";
export const CODELIA_MCP_AUTH_KEYCHAIN_SERVICE = "codelia.mcp-auth";

const DEFAULT_SECURITY_PATH = "/usr/bin/security";
const DEFAULT_ASYNC_TIMEOUT_MS = 5_000;
const DEFAULT_SYNC_TIMEOUT_MS = 2_000;
const AUTHORIZATION_TIMEOUT_MS = 120_000;
const MAX_SECURITY_BUFFER = 8 * 1024 * 1024;
const SECURITY_INTERACTIVE_MAX_LINE_BYTES = 4_096;
const MAX_STDERR_CAPTURE_BYTES = 16_384;
const MAX_CHUNKS = 64;
const SWEEP_CONSECUTIVE_MISS_LIMIT = 2;
/**
 * Apple's `/usr/bin/security -i` reads stdin lines into a 4,096-byte buffer
 * (`SecurityTool/macOS/readline.c`). 1,800 raw bytes base64-encodes to 2,400
 * ASCII characters, keeping every `add-generic-password` command line under
 * ~2,550 bytes while supporting payloads up to 115,200 raw bytes (64 chunks).
 */
const CHUNK_RAW_BYTES = 1_800;
export const MAX_KEYCHAIN_PAYLOAD_BYTES = MAX_CHUNKS * CHUNK_RAW_BYTES;
const CHUNK_PREFIX = "cb1:";
const GEN_POINTER_PREFIX = "cb2:";
const SAFE_TOKEN_RE = /^[A-Za-z0-9._:#-]+$/;

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

const validateKeychainToken = (label: string, value: string): void => {
	if (!value || !SAFE_TOKEN_RE.test(value)) {
		throw new KeychainError(
			"keychain_error",
			`Invalid Keychain ${label} identifier`,
		);
	}
};

const chunkServiceName = (service: string, index: number): string =>
	index === 0 ? service : `${service}#${index}`;

const genChunkServiceName = (
	service: string,
	gen: string,
	index: number,
): string => `${service}#g:${gen}:${index}`;

const encodePayloadChunks = (value: string): string[] => {
	const raw = Buffer.from(value, "utf8");
	const total = Math.max(1, Math.ceil(raw.length / CHUNK_RAW_BYTES));
	if (total > MAX_CHUNKS) {
		throw new KeychainError(
			"keychain_error",
			`Keychain payload exceeds maximum size (${MAX_KEYCHAIN_PAYLOAD_BYTES} bytes)`,
		);
	}
	const chunks: string[] = [];
	for (let i = 0; i < total; i += 1) {
		const slice = raw.subarray(
			i * CHUNK_RAW_BYTES,
			Math.min(raw.length, (i + 1) * CHUNK_RAW_BYTES),
		);
		chunks.push(`${CHUNK_PREFIX}${total}:${slice.toString("base64")}`);
	}
	return chunks;
};

const FIXED_GEN_SLOTS = ["a", "b"] as const;

const parseGenPointer = (
	raw: string,
): { gen: string; total: number } | null => {
	if (!raw.startsWith(GEN_POINTER_PREFIX)) return null;
	const parts = raw.slice(GEN_POINTER_PREFIX.length).split(":");
	if (parts.length !== 2) {
		throw new KeychainError(
			"keychain_error",
			"Corrupt Keychain generation pointer",
		);
	}
	const [gen, totalStr] = parts;
	const total = Number.parseInt(totalStr, 10);
	if (
		!/^(?:a|b|[0-9a-f]{8,16})$/.test(gen) ||
		!Number.isInteger(total) ||
		total < 1 ||
		total > MAX_CHUNKS
	) {
		throw new KeychainError(
			"keychain_error",
			"Corrupt Keychain generation pointer metadata",
		);
	}
	return { gen, total };
};

const parseChunkEnvelope = (
	raw: string,
): { total: number; base64: string } | null => {
	if (!raw.startsWith(CHUNK_PREFIX)) return null;
	const rest = raw.slice(CHUNK_PREFIX.length);
	const sep = rest.indexOf(":");
	if (sep <= 0) {
		throw new KeychainError(
			"keychain_error",
			"Corrupt Keychain chunk envelope",
		);
	}
	const total = Number.parseInt(rest.slice(0, sep), 10);
	const base64 = rest.slice(sep + 1);
	if (
		!Number.isInteger(total) ||
		total < 1 ||
		total > MAX_CHUNKS ||
		!/^[A-Za-z0-9+/=]*$/.test(base64)
	) {
		throw new KeychainError(
			"keychain_error",
			"Corrupt Keychain chunk metadata",
		);
	}
	return { total, base64 };
};

const extractValidatedChunkBase64 = (
	rawChunk: string | null,
	expectedTotal: number,
	index: number,
	service: string,
): string => {
	if (rawChunk === null) {
		throw new KeychainError(
			"keychain_error",
			`Missing Keychain chunk ${index + 1}/${expectedTotal} for ${service}`,
		);
	}
	const parsed = parseChunkEnvelope(rawChunk);
	if (!parsed || parsed.total !== expectedTotal) {
		throw new KeychainError(
			"keychain_error",
			`Inconsistent Keychain chunk ${index + 1}/${expectedTotal} for ${service}`,
		);
	}
	return parsed.base64;
};

const decodeBase64Chunks = (parts: readonly string[]): string =>
	Buffer.from(parts.join(""), "base64").toString("utf8");

const extractActiveGenSlot = (previousRoot: string | null): string | null => {
	if (!previousRoot) return null;
	try {
		return parseGenPointer(previousRoot)?.gen ?? null;
	} catch {
		return null;
	}
};

const decodeLegacyOrSingleValue = (trimmed: string): string => {
	if (trimmed.startsWith("{")) return trimmed;
	if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
		const decoded = Buffer.from(trimmed, "hex").toString("utf8");
		if (decoded.startsWith("{")) return decoded;
	}
	throw new KeychainError(
		"keychain_error",
		"Keychain item contains unrecognized credential format",
	);
};

const isNotFoundOutput = (code: number | null, stderr: string): boolean =>
	code === 44 ||
	/could not be found in the keychain|SecKeychainSearchCopyNext: The specified item could not be found/i.test(
		stderr,
	);

const classifySecurityFailure = (
	code: number | null,
	stderr: string,
	timedOut = false,
): KeychainError => {
	if (timedOut) {
		return new KeychainError(
			"keychain_error",
			"macOS Keychain operation timed out",
		);
	}
	if (
		code === 36 ||
		/User interaction is not allowed|errSecInteractionNotAllowed|keychain is locked/i.test(
			stderr,
		)
	) {
		return new KeychainError(
			"keychain_locked",
			"macOS login Keychain is locked; run `security unlock-keychain ~/Library/Keychains/login.keychain-db`",
		);
	}
	if (
		code === 128 ||
		/User canceled the operation|errSecUserCanceled|errSecAuthFailed|The user name or passphrase you entered is not correct/i.test(
			stderr,
		)
	) {
		return new KeychainError(
			"keychain_access_denied",
			"macOS Keychain denied access; run `codelia auth authorize-keychain` from a local terminal",
		);
	}
	return new KeychainError("keychain_error", "macOS Keychain operation failed");
};

const securityEnv = (): NodeJS.ProcessEnv => ({
	HOME: os.homedir(),
	PATH: "/usr/bin:/bin",
	...(process.env.USER ? { USER: process.env.USER } : {}),
	...(process.env.LOGNAME ? { LOGNAME: process.env.LOGNAME } : {}),
});

export type MacOsKeychainClientOptions = {
	securityPath?: string;
	helperPath?: string;
	credentialsDir?: string;
};

export class MacOsKeychainClient implements KeychainClient {
	private readonly securityBinary: string;
	private readonly hasCustomBinary: boolean;

	constructor(options?: MacOsKeychainClientOptions) {
		const custom = options?.securityPath ?? options?.helperPath;
		this.securityBinary = custom ?? DEFAULT_SECURITY_PATH;
		this.hasCustomBinary = Boolean(custom);
	}

	private resolveBinary(): string | null {
		if (!this.hasCustomBinary && process.platform !== "darwin") {
			return null;
		}
		if (
			!this.hasCustomBinary &&
			process.env.CODELIA_TEST_KEYCHAIN_DISABLED === "1"
		) {
			throw new KeychainError(
				"keychain_unavailable",
				"macOS Keychain is disabled for tests",
			);
		}
		try {
			accessSync(this.securityBinary, constants.X_OK);
			return this.securityBinary;
		} catch {
			return null;
		}
	}

	private requireBinary(): string {
		const binary = this.resolveBinary();
		if (!binary) {
			throw new KeychainError(
				"keychain_unavailable",
				process.platform !== "darwin"
					? "unsupported_platform"
					: "macOS /usr/bin/security is unavailable",
			);
		}
		return binary;
	}

	private runArgsAsync(
		args: readonly string[],
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const binary = this.requireBinary();
		return new Promise((resolve, reject) => {
			execFile(
				binary,
				[...args],
				{
					cwd: "/private/tmp",
					env: securityEnv(),
					timeout: timeoutMs,
					maxBuffer: MAX_SECURITY_BUFFER,
					encoding: "utf8",
				},
				(error, stdout, stderr) => {
					if (!error) {
						resolve({ code: 0, stdout, stderr });
						return;
					}
					const timedOut = Boolean(error.killed && error.code === null);
					const exitCode = typeof error.code === "number" ? error.code : null;
					if (timedOut) {
						reject(classifySecurityFailure(exitCode, stderr ?? "", true));
						return;
					}
					resolve({
						code: exitCode ?? 1,
						stdout: stdout ?? "",
						stderr: stderr ?? error.message,
					});
				},
			);
		});
	}

	private runInteractiveBatchAsync(
		commands: readonly string[],
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<void> {
		const binary = this.requireBinary();
		const payload = `${commands.join("\n")}\n`;
		for (const line of commands) {
			if (
				Buffer.byteLength(line, "utf8") + 1 >=
				SECURITY_INTERACTIVE_MAX_LINE_BYTES
			) {
				throw new KeychainError(
					"keychain_error",
					"Keychain batch command exceeds 4096-byte security -i line limit",
				);
			}
		}
		return new Promise((resolve, reject) => {
			const child = spawn(binary, ["-i"], {
				cwd: "/private/tmp",
				env: securityEnv(),
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.stdout.on("data", () => undefined);
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < MAX_STDERR_CAPTURE_BYTES) {
					stderr += chunk.toString("utf8");
				}
			});
			child.once("error", () => {
				clearTimeout(timer);
				reject(
					new KeychainError(
						"keychain_unavailable",
						"Failed to launch macOS /usr/bin/security",
					),
				);
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				if (timedOut) {
					reject(classifySecurityFailure(code, stderr, true));
					return;
				}
				if (code !== 0) {
					reject(classifySecurityFailure(code, stderr, false));
					return;
				}
				resolve();
			});
			child.stdin.on("error", () => undefined);
			child.stdin.end(payload);
		});
	}

	private findRawAsync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<string | null> {
		validateKeychainToken("service", service);
		validateKeychainToken("account", account);
		return this.runArgsAsync(
			["find-generic-password", "-w", "-a", account, "-s", service],
			timeoutMs,
		).then(({ code, stdout, stderr }) => {
			if (code === 0) return stdout.replace(/\r?\n$/, "");
			if (isNotFoundOutput(code, stderr)) return null;
			throw classifySecurityFailure(code, stderr);
		});
	}

	private findRawSync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): string | null {
		validateKeychainToken("service", service);
		validateKeychainToken("account", account);
		const binary = this.requireBinary();
		try {
			const stdout = execFileSync(
				binary,
				["find-generic-password", "-w", "-a", account, "-s", service],
				{
					cwd: "/private/tmp",
					env: securityEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					timeout: timeoutMs,
					maxBuffer: MAX_SECURITY_BUFFER,
					encoding: "utf8",
				},
			);
			return stdout.replace(/\r?\n$/, "");
		} catch (error) {
			const err = error as {
				status?: number | null;
				stderr?: string | Buffer;
				signal?: string | null;
			};
			const status = typeof err.status === "number" ? err.status : null;
			const stderr =
				typeof err.stderr === "string"
					? err.stderr
					: Buffer.isBuffer(err.stderr)
						? err.stderr.toString("utf8")
						: "";
			const timedOut = status === null && Boolean(err.signal);
			if (!timedOut && isNotFoundOutput(status, stderr)) {
				return null;
			}
			throw classifySecurityFailure(status, stderr, timedOut);
		}
	}

	async probe(): Promise<KeychainProbeResult> {
		if (!this.hasCustomBinary && process.platform !== "darwin") {
			return {
				available: false,
				reason: "unsupported_platform",
				message: "OS Keychain backend is currently supported on macOS only",
			};
		}
		try {
			const binary = this.resolveBinary();
			if (!binary) {
				return {
					available: false,
					reason: "keychain_unavailable",
					message: "macOS /usr/bin/security is unavailable",
				};
			}
			const { code, stderr } = await this.runArgsAsync(["show-keychain-info"]);
			if (code === 0) return { available: true };
			const classified = classifySecurityFailure(code, stderr);
			return {
				available: false,
				reason:
					classified.code === "keychain_locked"
						? "keychain_locked"
						: "keychain_unavailable",
				message: classified.message,
			};
		} catch (error) {
			const isLocked =
				error instanceof KeychainError && error.code === "keychain_locked";
			return {
				available: false,
				reason: isLocked ? "keychain_locked" : "keychain_unavailable",
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async readFullAsync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS,
	): Promise<string | null> {
		const first = await this.findRawAsync(service, account, timeoutMs);
		if (first === null) return null;
		const ptr = parseGenPointer(first);
		if (ptr) {
			const parts: string[] = [];
			for (let i = 0; i < ptr.total; i += 1) {
				const rawChunk = await this.findRawAsync(
					genChunkServiceName(service, ptr.gen, i),
					account,
					timeoutMs,
				);
				parts.push(
					extractValidatedChunkBase64(rawChunk, ptr.total, i, service),
				);
			}
			return decodeBase64Chunks(parts);
		}
		const env0 = parseChunkEnvelope(first);
		if (!env0) return decodeLegacyOrSingleValue(first);
		const parts = [env0.base64];
		for (let i = 1; i < env0.total; i += 1) {
			const rawChunk = await this.findRawAsync(
				chunkServiceName(service, i),
				account,
				timeoutMs,
			);
			parts.push(extractValidatedChunkBase64(rawChunk, env0.total, i, service));
		}
		return decodeBase64Chunks(parts);
	}

	async get(service: string, account: string): Promise<string | null> {
		return this.readFullAsync(service, account, DEFAULT_ASYNC_TIMEOUT_MS);
	}

	getSync(
		service: string,
		account: string,
		timeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
	): string | null {
		const first = this.findRawSync(service, account, timeoutMs);
		if (first === null) return null;
		const ptr = parseGenPointer(first);
		if (ptr) {
			const parts: string[] = [];
			for (let i = 0; i < ptr.total; i += 1) {
				const rawChunk = this.findRawSync(
					genChunkServiceName(service, ptr.gen, i),
					account,
					timeoutMs,
				);
				parts.push(
					extractValidatedChunkBase64(rawChunk, ptr.total, i, service),
				);
			}
			return decodeBase64Chunks(parts);
		}
		const env0 = parseChunkEnvelope(first);
		if (!env0) return decodeLegacyOrSingleValue(first);
		const parts = [env0.base64];
		for (let i = 1; i < env0.total; i += 1) {
			const rawChunk = this.findRawSync(
				chunkServiceName(service, i),
				account,
				timeoutMs,
			);
			parts.push(extractValidatedChunkBase64(rawChunk, env0.total, i, service));
		}
		return decodeBase64Chunks(parts);
	}

	private async sweepGenSlotBestEffort(
		service: string,
		account: string,
		gen: string,
		startIndex = 0,
	): Promise<void> {
		let consecutiveMisses = 0;
		for (let i = startIndex; i < MAX_CHUNKS; i += 1) {
			const deleted = await this.deleteSingleItem(
				genChunkServiceName(service, gen, i),
				account,
			).catch(() => false);
			if (deleted) {
				consecutiveMisses = 0;
			} else {
				consecutiveMisses += 1;
				if (consecutiveMisses >= SWEEP_CONSECUTIVE_MISS_LIMIT) break;
			}
		}
	}

	/**
	 * Exhaustively delete every possible chunk index (`0..MAX_CHUNKS-1`) in a
	 * fixed generation slot and propagate any non-not-found delete error.
	 */
	private async deleteAllSlotChunksStrict(
		service: string,
		account: string,
		gen: string,
	): Promise<boolean> {
		let deletedAny = false;
		for (let i = 0; i < MAX_CHUNKS; i += 1) {
			const deleted = await this.deleteSingleItem(
				genChunkServiceName(service, gen, i),
				account,
			);
			if (deleted) deletedAny = true;
		}
		return deletedAny;
	}

	private async cleanupOldChunks(
		service: string,
		account: string,
		previousRoot: string | null,
		keepGen?: string,
	): Promise<void> {
		try {
			if (previousRoot) {
				let prevPtr: { gen: string; total: number } | null = null;
				try {
					prevPtr = parseGenPointer(previousRoot);
				} catch {
					prevPtr = null;
				}
				if (prevPtr && prevPtr.gen !== keepGen) {
					for (let i = 0; i < prevPtr.total; i += 1) {
						await this.deleteSingleItem(
							genChunkServiceName(service, prevPtr.gen, i),
							account,
						).catch(() => false);
					}
				}
				let prevCb1: { total: number; base64: string } | null = null;
				try {
					prevCb1 = parseChunkEnvelope(previousRoot);
				} catch {
					prevCb1 = null;
				}
				if (prevCb1 && prevCb1.total > 1) {
					for (let i = 1; i < prevCb1.total; i += 1) {
						await this.deleteSingleItem(
							chunkServiceName(service, i),
							account,
						).catch(() => false);
					}
				}
			}
			// Best-effort sweep of non-active fixed A/B slots after a successful write.
			for (const slot of FIXED_GEN_SLOTS) {
				if (slot !== keepGen) {
					await this.sweepGenSlotBestEffort(service, account, slot, 0);
				}
			}
		} catch {
			// Best-effort cleanup of superseded chunk items.
		}
	}

	private async writeSingleChunk(
		service: string,
		account: string,
		encoded: string,
		previousRoot: string | null,
	): Promise<void> {
		await this.runInteractiveBatchAsync([
			`add-generic-password -U -a ${account} -s ${service} -w ${encoded}`,
		]);
		// `security -i` can exit 0 even when a subcommand failed; verify read-back.
		const verified = await this.findRawAsync(service, account);
		if (verified !== encoded) {
			throw new KeychainError(
				"keychain_error",
				"macOS Keychain write verification failed",
			);
		}
		await this.cleanupOldChunks(service, account, previousRoot);
	}

	/**
	 * Multi-chunk write: alternates between fixed A/B slots (`a` and `b`) so
	 * existing credentials stay untouched until every staged chunk verifies via
	 * read-back AND crashed writes remain deterministically discoverable on logout.
	 */
	private async writeMultiChunk(
		service: string,
		account: string,
		chunks: readonly string[],
		previousRoot: string | null,
	): Promise<void> {
		const gen = extractActiveGenSlot(previousRoot) === "a" ? "b" : "a";
		const stageCommands = chunks.map(
			(encoded, index) =>
				`add-generic-password -U -a ${account} -s ${genChunkServiceName(service, gen, index)} -w ${encoded}`,
		);
		const rollbackStaged = async (): Promise<void> => {
			for (let i = 0; i < chunks.length; i += 1) {
				await this.deleteSingleItem(
					genChunkServiceName(service, gen, i),
					account,
				).catch(() => false);
			}
		};
		try {
			await this.runInteractiveBatchAsync(stageCommands);
			for (let i = 0; i < chunks.length; i += 1) {
				const verified = await this.findRawAsync(
					genChunkServiceName(service, gen, i),
					account,
				);
				if (verified !== chunks[i]) {
					throw new KeychainError(
						"keychain_error",
						`macOS Keychain staged chunk ${i + 1}/${chunks.length} failed verification`,
					);
				}
			}
		} catch (error) {
			await rollbackStaged();
			throw error;
		}

		const pointerValue = `${GEN_POINTER_PREFIX}${gen}:${chunks.length}`;
		await this.runInteractiveBatchAsync([
			`add-generic-password -U -a ${account} -s ${service} -w ${pointerValue}`,
		]);
		const verifiedPointer = await this.findRawAsync(service, account);
		if (verifiedPointer !== pointerValue) {
			await rollbackStaged();
			throw new KeychainError(
				"keychain_error",
				"macOS Keychain pointer verification failed",
			);
		}
		await this.sweepGenSlotBestEffort(service, account, gen, chunks.length);
		await this.cleanupOldChunks(service, account, previousRoot, gen);
	}

	async set(service: string, account: string, value: string): Promise<void> {
		validateKeychainToken("service", service);
		validateKeychainToken("account", account);
		const chunks = encodePayloadChunks(value);
		// Only treat the write as initial when the root item is confirmed absent (44);
		// any read/timeout failure aborts before touching any slot.
		const previousRoot = await this.findRawAsync(service, account);
		if (chunks.length === 1) {
			await this.writeSingleChunk(service, account, chunks[0], previousRoot);
			return;
		}
		await this.writeMultiChunk(service, account, chunks, previousRoot);
	}

	private async deleteSingleItem(
		service: string,
		account: string,
	): Promise<boolean> {
		validateKeychainToken("service", service);
		validateKeychainToken("account", account);
		const { code, stderr } = await this.runArgsAsync([
			"delete-generic-password",
			"-a",
			account,
			"-s",
			service,
		]);
		if (code === 0) return true;
		if (isNotFoundOutput(code, stderr)) return false;
		throw classifySecurityFailure(code, stderr);
	}

	async delete(service: string, account: string): Promise<boolean> {
		validateKeychainToken("service", service);
		validateKeychainToken("account", account);
		const existing = await this.findRawAsync(service, account);
		let deletedAny = false;
		if (existing) {
			let prevCb1: { total: number; base64: string } | null = null;
			try {
				prevCb1 = parseChunkEnvelope(existing);
			} catch {
				prevCb1 = null;
			}
			if (prevCb1 && prevCb1.total > 1) {
				for (let i = 1; i < prevCb1.total; i += 1) {
					if (
						await this.deleteSingleItem(chunkServiceName(service, i), account)
					) {
						deletedAny = true;
					}
				}
			}
			let prevPtr: { gen: string; total: number } | null = null;
			try {
				prevPtr = parseGenPointer(existing);
			} catch {
				prevPtr = null;
			}
			if (
				prevPtr &&
				!FIXED_GEN_SLOTS.includes(
					prevPtr.gen as (typeof FIXED_GEN_SLOTS)[number],
				)
			) {
				for (let i = 0; i < prevPtr.total; i += 1) {
					if (
						await this.deleteSingleItem(
							genChunkServiceName(service, prevPtr.gen, i),
							account,
						)
					) {
						deletedAny = true;
					}
				}
			}
		}
		const deletedPrimary = await this.deleteSingleItem(service, account);
		if (deletedPrimary) deletedAny = true;
		for (const slot of FIXED_GEN_SLOTS) {
			if (await this.deleteAllSlotChunksStrict(service, account, slot)) {
				deletedAny = true;
			}
		}
		return deletedAny;
	}

	/**
	 * Interactive authorization helper for `codelia auth authorize-keychain`:
	 * reads existing items with a 2-minute interactive timeout and re-saves them
	 * via `/usr/bin/security` so `/usr/bin/security` is in the item's ACL.
	 */
	async authorize(service: string, account: string): Promise<boolean> {
		const fullValue = await this.readFullAsync(
			service,
			account,
			AUTHORIZATION_TIMEOUT_MS,
		);
		if (fullValue === null) return false;
		await this.set(service, account, fullValue);
		return true;
	}
}
