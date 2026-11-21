import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import type { StoragePaths } from "@codelia/core";
import { writeFileAtomic } from "./atomic-file";
import {
	type AuthLockOptions,
	authLockPathFor,
	withAuthStoreLock,
} from "./auth-lock";
import {
	type AuthStorageState,
	type CredentialBackendKind,
	CredentialConflictError,
	canonicalJsonEqual,
	readAuthStorageState,
	runTwoPhaseMigration,
	type StoreMigrationSlot,
	writeAuthStorageState,
} from "./credential-migration";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	type KeychainClient,
	KeychainError,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
} from "./macos-keychain";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";

export type ConfiguredAuthStorageMode = "auto" | "keyring" | "file";
export type AuthStorageFallbackReason =
	| "unsupported_platform"
	| "keychain_locked"
	| "keychain_unavailable";

export type ResolvedCredentialBackend = {
	configured: ConfiguredAuthStorageMode;
	active: CredentialBackendKind;
	state: "steady" | "migrating";
	fallbackReason?: AuthStorageFallbackReason;
};

export type CredentialStoreRuntimeOptions = {
	paths?: StoragePaths;
	lock?: AuthLockOptions;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const parseStorageModeValue = (
	value: unknown,
): ConfiguredAuthStorageMode | undefined => {
	if (value === "auto" || value === "keyring" || value === "file") {
		return value;
	}
	return undefined;
};

/**
 * Resolve `auth.storage` strictly from `CODELIA_AUTH_STORAGE` or the global
 * `config.json`. Project-level `.codelia/config.json` is never consulted.
 */
export const resolveConfiguredAuthStorageMode = (
	paths: StoragePaths,
	overrideMode?: ConfiguredAuthStorageMode,
): ConfiguredAuthStorageMode => {
	if (overrideMode) return overrideMode;
	const envRaw = process.env.CODELIA_AUTH_STORAGE?.trim();
	if (envRaw) {
		const parsed = parseStorageModeValue(envRaw);
		if (!parsed) {
			throw new Error(
				`Invalid CODELIA_AUTH_STORAGE="${envRaw}" (expected "auto", "keyring", or "file")`,
			);
		}
		return parsed;
	}
	const globalConfigPath = process.env.CODELIA_CONFIG_PATH?.trim()
		? path.resolve(process.env.CODELIA_CONFIG_PATH.trim())
		: paths.configFile;
	try {
		const raw = readFileSync(globalConfigPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (isRecord(parsed) && isRecord(parsed.auth)) {
			const mode = parsed.auth.storage;
			if (mode !== undefined) {
				const valid = parseStorageModeValue(mode);
				if (!valid) {
					throw new Error(
						`Invalid global auth.storage="${String(mode)}" (expected "auto", "keyring", or "file")`,
					);
				}
				return valid;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			// Malformed JSON or invalid value: let invalid storage mode propagate,
			// ignore unrelated config parse errors so auth status stays diagnostic.
			if (
				error instanceof Error &&
				error.message.startsWith("Invalid global auth.storage")
			) {
				throw error;
			}
		}
	}
	return "auto";
};

const readTextIfPresent = async (filePath: string): Promise<string | null> => {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
};

export type StoreAdapter<T> = {
	name: "auth" | "mcp_auth";
	service: string;
	filePath: (paths: StoragePaths) => string;
	legacyFilePath: (paths: StoragePaths) => string;
	empty: () => T;
	isNonEmpty: (doc: T) => boolean;
	parse: (text: string) => {
		normalized: T;
		sourceVersion: 1 | 2;
		extraWarnings?: string[];
	};
};

const readFileSlot = async <T>(
	filePath: string,
	adapter: StoreAdapter<T>,
): Promise<{
	present: boolean;
	normalized: T;
	nonEmpty: boolean;
	sourceVersion?: 1 | 2;
	extraWarnings?: string[];
}> => {
	const text = await readTextIfPresent(filePath);
	if (text === null) {
		return { present: false, normalized: adapter.empty(), nonEmpty: false };
	}
	const parsed = adapter.parse(text);
	return {
		present: true,
		normalized: parsed.normalized,
		nonEmpty: adapter.isNonEmpty(parsed.normalized),
		sourceVersion: parsed.sourceVersion,
		extraWarnings: parsed.extraWarnings,
	};
};

const readKeychainSlot = async <T>(
	keychain: KeychainClient,
	service: string,
	account: string,
	adapter: StoreAdapter<T>,
): Promise<{
	present: boolean;
	normalized: T;
	nonEmpty: boolean;
}> => {
	const text = await keychain.get(service, account);
	if (text === null) {
		return { present: false, normalized: adapter.empty(), nonEmpty: false };
	}
	const parsed = adapter.parse(text);
	return {
		present: true,
		normalized: parsed.normalized,
		nonEmpty: adapter.isNonEmpty(parsed.normalized),
	};
};

const unlinkIfPresent = async (filePath: string): Promise<void> => {
	try {
		await fs.unlink(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
		throw error;
	}
};

const makeKeychainTargetSlot = <T>(
	keychain: KeychainClient,
	account: string,
	adapter: StoreAdapter<T>,
	sourcePath: string,
): StoreMigrationSlot<T> => ({
	name: adapter.name,
	readSource: () => readFileSlot(sourcePath, adapter),
	readDest: () => readKeychainSlot(keychain, adapter.service, account, adapter),
	writeDest: async (normalized) => {
		await keychain.set(adapter.service, account, JSON.stringify(normalized));
	},
	verifyDest: async (expected) => {
		const back = await readKeychainSlot(
			keychain,
			adapter.service,
			account,
			adapter,
		);
		return back.present && canonicalJsonEqual(back.normalized, expected);
	},
	cleanupSource: () => unlinkIfPresent(sourcePath),
});

const makeFileFromKeychainSlot = <T>(
	paths: StoragePaths,
	keychain: KeychainClient,
	account: string,
	adapter: StoreAdapter<T>,
): StoreMigrationSlot<T> => {
	const destPath = adapter.filePath(paths);
	return {
		name: adapter.name,
		readSource: () =>
			readKeychainSlot(keychain, adapter.service, account, adapter),
		readDest: () => readFileSlot(destPath, adapter),
		writeDest: async (normalized) => {
			await ensureStorageDirs(paths);
			await writeFileAtomic(destPath, JSON.stringify(normalized, null, 2), {
				mode: 0o600,
			});
		},
		verifyDest: async (expected) => {
			const back = await readFileSlot(destPath, adapter);
			return back.present && canonicalJsonEqual(back.normalized, expected);
		},
		cleanupSource: async () => {
			await keychain.delete(adapter.service, account);
		},
	};
};

const makeFileFromLegacySlot = <T>(
	paths: StoragePaths,
	adapter: StoreAdapter<T>,
): StoreMigrationSlot<T> => {
	const sourcePath = adapter.legacyFilePath(paths);
	const destPath = adapter.filePath(paths);
	return {
		name: adapter.name,
		readSource: () => readFileSlot(sourcePath, adapter),
		readDest: () => readFileSlot(destPath, adapter),
		writeDest: async (normalized) => {
			await ensureStorageDirs(paths);
			await writeFileAtomic(destPath, JSON.stringify(normalized, null, 2), {
				mode: 0o600,
			});
		},
		verifyDest: async (expected) => {
			const back = await readFileSlot(destPath, adapter);
			return back.present && canonicalJsonEqual(back.normalized, expected);
		},
		cleanupSource: () => unlinkIfPresent(sourcePath),
	};
};

/**
 * Finish any persisted post-verification source cleanup (e.g. Keychain delete
 * after `keyring -> file` reverse migration crashed before removing old items).
 */
const completePendingCleanupUnlocked = async <TAuth, TMcp>(options: {
	paths: StoragePaths;
	state: Extract<AuthStorageState, { status: "migrating" }>;
	keychain: KeychainClient;
	account: string;
	authAdapter: StoreAdapter<TAuth>;
	mcpAdapter: StoreAdapter<TMcp>;
}): Promise<AuthStorageState> => {
	const pending = options.state.cleanup_pending;
	if (!pending) return options.state;

	if (pending.source_backend === "keyring") {
		const probe = await options.keychain.probe();
		if (!probe.available) {
			throw new KeychainError(
				probe.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				`Cannot finish cleanup of previous Keychain credentials after migration while Keychain is unavailable (${probe.reason}): ${probe.message}`,
			);
		}
		if (pending.auth) {
			await options.keychain.delete(
				options.authAdapter.service,
				options.account,
			);
		}
		if (pending.mcp_auth) {
			await options.keychain.delete(
				options.mcpAdapter.service,
				options.account,
			);
		}
	} else {
		// source_backend === "file"
		const cleanupAuthPath =
			options.state.target_backend === "keyring"
				? options.authAdapter.filePath(options.paths)
				: options.authAdapter.legacyFilePath(options.paths);
		const cleanupMcpPath =
			options.state.target_backend === "keyring"
				? options.mcpAdapter.filePath(options.paths)
				: options.mcpAdapter.legacyFilePath(options.paths);
		if (pending.auth) {
			await unlinkIfPresent(cleanupAuthPath);
		}
		if (pending.mcp_auth) {
			await unlinkIfPresent(cleanupMcpPath);
		}
	}

	const committed: AuthStorageState = {
		version: 1,
		status: "steady",
		active_backend: options.state.target_backend,
		...(options.state.mcp_reauth_required?.length
			? { mcp_reauth_required: options.state.mcp_reauth_required }
			: {}),
	};
	await writeAuthStorageState(options.paths.authStateFile, committed);
	return committed;
};

/**
 * Determine target backend and perform any needed two-phase forward/reverse
 * migration under the interprocess lock (spec §9.1 & §9.6).
 */
export const coordinateCredentialBackendUnlocked = async <
	TAuth,
	TMcp,
>(options: {
	paths: StoragePaths;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
	authAdapter: StoreAdapter<TAuth>;
	mcpAdapter: StoreAdapter<TMcp>;
}): Promise<ResolvedCredentialBackend> => {
	const { paths, authAdapter, mcpAdapter } = options;
	const keychain = options.keychain ?? new MacOsKeychainClient();
	const configured = resolveConfiguredAuthStorageMode(
		paths,
		options.storageMode,
	);
	const account = keychainAccountForConfigDir(paths.configDir);

	await ensureStorageDirs(paths);
	let state: AuthStorageState | null = await readAuthStorageState(
		paths.authStateFile,
	);

	// Step 0: Resume any persisted post-verification cleanup BEFORE making new
	// backend decisions so interrupted reverse/forward migrations cannot strand
	// stale credentials on the previous backend.
	if (state?.status === "migrating" && state.cleanup_pending) {
		state = await completePendingCleanupUnlocked({
			paths,
			state,
			keychain,
			account,
			authAdapter,
			mcpAdapter,
		});
	}

	// Helper: migrate any legacy root files into credentials/ first so subsequent
	// file <-> keyring steps only deal with one file location.
	const migrateLegacyToCredentials = async (): Promise<void> => {
		const [legacyAuth, legacyMcp] = await Promise.all([
			readTextIfPresent(authAdapter.legacyFilePath(paths)),
			readTextIfPresent(mcpAdapter.legacyFilePath(paths)),
		]);
		if (legacyAuth === null && legacyMcp === null) return;
		await runTwoPhaseMigration({
			stateFile: paths.authStateFile,
			fromBackend: state?.active_backend ?? "file",
			toBackend: state?.active_backend ?? "file",
			authSlot: makeFileFromLegacySlot(paths, authAdapter),
			mcpSlot: makeFileFromLegacySlot(paths, mcpAdapter),
			existingMcpReauth: state?.mcp_reauth_required,
		});
		state = await readAuthStorageState(paths.authStateFile);
	};

	const keyringOwnedOrInFlight =
		state?.active_backend === "keyring" ||
		(state?.status === "migrating" && state.target_backend === "keyring");

	if (configured === "file") {
		await migrateLegacyToCredentials();
		if (keyringOwnedOrInFlight) {
			// Explicit reverse migration / rollback (keyring -> file)
			const probe = await keychain.probe();
			if (!probe.available) {
				throw new KeychainError(
					probe.reason === "keychain_locked"
						? "keychain_locked"
						: "keychain_unavailable",
					`Cannot switch auth.storage to "file" while Keychain is unavailable: ${probe.message}`,
				);
			}
			await runTwoPhaseMigration({
				stateFile: paths.authStateFile,
				fromBackend: "keyring",
				toBackend: "file",
				authSlot: makeFileFromKeychainSlot(
					paths,
					keychain,
					account,
					authAdapter,
				),
				mcpSlot: makeFileFromKeychainSlot(paths, keychain, account, mcpAdapter),
				existingMcpReauth: state?.mcp_reauth_required,
				commitSteadyIfEmpty: true,
			});
			state = await readAuthStorageState(paths.authStateFile);
		} else if (!state || state.status === "migrating") {
			await writeAuthStorageState(paths.authStateFile, {
				version: 1,
				status: "steady",
				active_backend: "file",
				...(state?.mcp_reauth_required?.length
					? { mcp_reauth_required: state.mcp_reauth_required }
					: {}),
			});
		}
		return {
			configured,
			active: "file",
			state: "steady",
		};
	}

	// configured === "keyring" or "auto"
	const probe = await keychain.probe();

	if (!probe.available) {
		if (configured === "keyring") {
			throw new KeychainError(
				probe.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				probe.message,
			);
		}
		// configured === "auto": NEVER silently fall back if Keychain already owns
		// credentials or a migration targeting Keychain was interrupted (spec §9.1).
		if (keyringOwnedOrInFlight) {
			throw new KeychainError(
				probe.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				`Credentials are managed in macOS Keychain, but Keychain is unavailable (${probe.reason}). Unlock Keychain (e.g. \`security unlock-keychain ~/Library/Keychains/login.keychain-db\`) or explicitly switch auth.storage to "file".`,
			);
		}
		// Unmigrated platform/headless fallback to file
		await migrateLegacyToCredentials();
		return {
			configured,
			active: "file",
			state: "steady",
			fallbackReason: probe.reason,
		};
	}

	// Keychain is available! First reconcile any legacy root files -> credentials/,
	// then run two-phase forward migration credentials/ -> Keychain.
	await migrateLegacyToCredentials();
	const [credAuthText, credMcpText] = await Promise.all([
		readTextIfPresent(authAdapter.filePath(paths)),
		readTextIfPresent(mcpAdapter.filePath(paths)),
	]);

	if (
		credAuthText !== null ||
		credMcpText !== null ||
		state?.status === "migrating"
	) {
		await runTwoPhaseMigration({
			stateFile: paths.authStateFile,
			fromBackend: "file",
			toBackend: "keyring",
			authSlot: makeKeychainTargetSlot(
				keychain,
				account,
				authAdapter,
				authAdapter.filePath(paths),
			),
			mcpSlot: makeKeychainTargetSlot(
				keychain,
				account,
				mcpAdapter,
				mcpAdapter.filePath(paths),
			),
			existingMcpReauth: state?.mcp_reauth_required,
			commitSteadyIfEmpty: true,
		});
		state = await readAuthStorageState(paths.authStateFile);
	} else if (state?.active_backend !== "keyring") {
		// Fresh Keychain initialization with no existing files
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
			...(state?.mcp_reauth_required?.length
				? { mcp_reauth_required: state.mcp_reauth_required }
				: {}),
		});
	}

	return {
		configured,
		active: "keyring",
		state: "steady",
	};
};

export const coordinateCredentialBackend = <TAuth, TMcp>(options: {
	paths?: StoragePaths;
	lock?: AuthLockOptions;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
	authAdapter: StoreAdapter<TAuth>;
	mcpAdapter: StoreAdapter<TMcp>;
}): Promise<ResolvedCredentialBackend> => {
	const paths = options.paths ?? resolveStoragePaths();
	return withAuthStoreLock(
		authLockPathFor(paths.credentialsDir),
		() =>
			coordinateCredentialBackendUnlocked({
				...options,
				paths,
			}),
		options.lock,
	);
};

export type CredentialConflictResolutionStrategy =
	| "keep_keyring"
	| "keep_file"
	| "keep_legacy"
	| "clear_all";

/**
 * Remove a single store (`auth` or `mcp_auth`) across ALL credential locations
 * (protected `credentials/`, legacy root, and Keychain if reachable) under an
 * already-held interprocess lock. Used for explicit full logout (`clearAll`)
 * so users are never trapped by a dual-store conflict when wiping credentials.
 */
export const clearStoreAcrossAllLocationsUnlocked = async <T>(options: {
	paths: StoragePaths;
	adapter: StoreAdapter<T>;
	keychain?: KeychainClient;
}): Promise<void> => {
	const { paths, adapter } = options;
	const keychain = options.keychain ?? new MacOsKeychainClient();
	const account = keychainAccountForConfigDir(paths.configDir);
	await ensureStorageDirs(paths);
	await unlinkIfPresent(adapter.filePath(paths));
	await unlinkIfPresent(adapter.legacyFilePath(paths));
	const probe = await keychain.probe();
	if (probe.available) {
		await keychain.delete(adapter.service, account);
	} else {
		// If Keychain owns credentials and is locked, fail closed so we do not
		// claim full logout succeeded while Keychain still holds secrets.
		const storedState = await readAuthStorageState(paths.authStateFile).catch(
			() => null,
		);
		const keyringInvolved =
			storedState?.active_backend === "keyring" ||
			(storedState?.status === "migrating" &&
				(storedState.target_backend === "keyring" ||
					storedState.cleanup_pending?.source_backend === "keyring"));
		if (keyringInvolved) {
			throw new KeychainError(
				probe.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				`Cannot clear Keychain credentials while Keychain is unavailable (${probe.reason}): ${probe.message}`,
			);
		}
	}
};

/**
 * Explicit user-confirmed conflict resolution under the interprocess lock
 * (spec §9.6). Validates the chosen authoritative source before deleting
 * competing copies, or wipes all copies when `strategy === "clear_all"`.
 */
export const resolveCredentialConflict = async <TAuth, TMcp>(options: {
	paths?: StoragePaths;
	lock?: AuthLockOptions;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
	authAdapter: StoreAdapter<TAuth>;
	mcpAdapter: StoreAdapter<TMcp>;
	strategy: CredentialConflictResolutionStrategy;
	stores?: ReadonlyArray<"auth" | "mcp_auth">;
}): Promise<{
	active: CredentialBackendKind;
	resolvedStores: Array<"auth" | "mcp_auth">;
}> => {
	const paths = options.paths ?? resolveStoragePaths();
	const keychain = options.keychain ?? new MacOsKeychainClient();
	const account = keychainAccountForConfigDir(paths.configDir);
	const targets: Array<"auth" | "mcp_auth"> = options.stores?.length
		? [...new Set(options.stores)]
		: ["auth", "mcp_auth"];

	return withAuthStoreLock(
		authLockPathFor(paths.credentialsDir),
		async () => {
			await ensureStorageDirs(paths);
			const configured = resolveConfiguredAuthStorageMode(
				paths,
				options.storageMode,
			);
			const existingState = await readAuthStorageState(
				paths.authStateFile,
			).catch(() => null);
			const mcpReauth = existingState?.mcp_reauth_required;

			const resolveOne = async <T>(adapter: StoreAdapter<T>): Promise<void> => {
				if (options.strategy === "clear_all") {
					await clearStoreAcrossAllLocationsUnlocked({
						paths,
						adapter,
						keychain,
					});
					return;
				}
				if (options.strategy === "keep_keyring") {
					const probe = await keychain.probe();
					if (!probe.available) {
						throw new KeychainError(
							probe.reason === "keychain_locked"
								? "keychain_locked"
								: "keychain_unavailable",
							`Cannot keep Keychain credentials while Keychain is unavailable: ${probe.message}`,
						);
					}
					// Verify Keychain payload parses cleanly before removing files.
					await readKeychainSlot(keychain, adapter.service, account, adapter);
					await unlinkIfPresent(adapter.filePath(paths));
					await unlinkIfPresent(adapter.legacyFilePath(paths));
					return;
				}
				if (options.strategy === "keep_file") {
					// Verify protected file parses cleanly before removing competing copies.
					const slot = await readFileSlot(adapter.filePath(paths), adapter);
					if (!slot.present) {
						throw new Error(
							`Cannot keep file store for '${adapter.name}': ${adapter.filePath(paths)} does not exist`,
						);
					}
					await writeFileAtomic(
						adapter.filePath(paths),
						JSON.stringify(slot.normalized, null, 2),
						{ mode: 0o600 },
					);
					await unlinkIfPresent(adapter.legacyFilePath(paths));
					const probe = await keychain.probe();
					if (probe.available) {
						await keychain.delete(adapter.service, account);
					} else if (existingState?.active_backend === "keyring") {
						throw new KeychainError(
							probe.reason === "keychain_locked"
								? "keychain_locked"
								: "keychain_unavailable",
							`Cannot remove superseded Keychain entry while Keychain is unavailable: ${probe.message}`,
						);
					}
					return;
				}
				// strategy === "keep_legacy"
				const legacy = await readFileSlot(
					adapter.legacyFilePath(paths),
					adapter,
				);
				if (!legacy.present) {
					throw new Error(
						`Cannot keep legacy store for '${adapter.name}': ${adapter.legacyFilePath(paths)} does not exist`,
					);
				}
				const targetBackend: CredentialBackendKind =
					configured === "keyring"
						? "keyring"
						: configured === "file"
							? "file"
							: (await keychain.probe()).available
								? "keyring"
								: "file";
				if (targetBackend === "keyring") {
					const probe = await keychain.probe();
					if (!probe.available) {
						throw new KeychainError(
							probe.reason === "keychain_locked"
								? "keychain_locked"
								: "keychain_unavailable",
							`Cannot promote legacy store to Keychain while Keychain is unavailable: ${probe.message}`,
						);
					}
					await keychain.set(
						adapter.service,
						account,
						JSON.stringify(legacy.normalized),
					);
					const verify = await readKeychainSlot(
						keychain,
						adapter.service,
						account,
						adapter,
					);
					if (
						!verify.present ||
						!canonicalJsonEqual(verify.normalized, legacy.normalized)
					) {
						throw new Error(
							`Failed to verify promoted '${adapter.name}' in Keychain`,
						);
					}
					await unlinkIfPresent(adapter.filePath(paths));
					await unlinkIfPresent(adapter.legacyFilePath(paths));
				} else {
					await writeFileAtomic(
						adapter.filePath(paths),
						JSON.stringify(legacy.normalized, null, 2),
						{ mode: 0o600 },
					);
					await unlinkIfPresent(adapter.legacyFilePath(paths));
					const probe = await keychain.probe();
					if (probe.available) {
						await keychain.delete(adapter.service, account);
					}
				}
			};

			for (const storeName of targets) {
				if (storeName === "auth") {
					await resolveOne(options.authAdapter);
				} else {
					await resolveOne(options.mcpAdapter);
				}
			}

			const targetActive: CredentialBackendKind =
				options.strategy === "keep_keyring"
					? "keyring"
					: options.strategy === "keep_file"
						? "file"
						: configured === "file"
							? "file"
							: configured === "keyring"
								? "keyring"
								: (await keychain.probe()).available
									? "keyring"
									: "file";

			await writeAuthStorageState(paths.authStateFile, {
				version: 1,
				status: "steady",
				active_backend: targetActive,
				...(mcpReauth?.length ? { mcp_reauth_required: mcpReauth } : {}),
			});

			return { active: targetActive, resolvedStores: targets };
		},
		options.lock,
	);
};

/**
 * Non-mutating inspection for `auth.status` (spec §9.7).
 * Never leaks secrets and surfaces conflict / locked-keychain / migration state.
 */
export const inspectCredentialStorageStatus = async <TAuth, TMcp>(options: {
	paths?: StoragePaths;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
	authAdapter: StoreAdapter<TAuth>;
	mcpAdapter: StoreAdapter<TMcp>;
}): Promise<{
	configured: ConfiguredAuthStorageMode;
	active: CredentialBackendKind;
	state: "steady" | "migrating" | "conflict";
	fallbackReason?: AuthStorageFallbackReason;
	mcpReauthRequired: string[];
	conflictStores: Array<"auth" | "mcp_auth">;
}> => {
	const paths = options.paths ?? resolveStoragePaths();
	const keychain = options.keychain ?? new MacOsKeychainClient();
	const configured = resolveConfiguredAuthStorageMode(
		paths,
		options.storageMode,
	);
	const account = keychainAccountForConfigDir(paths.configDir);
	let stateCorrupt = false;
	let storedState: AuthStorageState | null = null;
	try {
		storedState = await readAuthStorageState(paths.authStateFile);
	} catch {
		stateCorrupt = true;
	}
	const mcpReauthRequired = storedState?.mcp_reauth_required ?? [];

	const keyringOwned =
		storedState?.active_backend === "keyring" ||
		(storedState?.status === "migrating" &&
			(storedState.target_backend === "keyring" ||
				storedState.cleanup_pending?.source_backend === "keyring"));

	const shouldProbeKeychain = configured !== "file" || keyringOwned;
	const probe = shouldProbeKeychain
		? await keychain.probe()
		: {
				available: false as const,
				reason: "keychain_unavailable" as const,
				message: "file mode selected",
			};

	const active: CredentialBackendKind =
		configured === "file"
			? keyringOwned
				? "keyring"
				: "file"
			: probe.available
				? "keyring"
				: keyringOwned || configured === "keyring"
					? "keyring"
					: "file";

	const fallbackReason: AuthStorageFallbackReason | undefined =
		configured === "auto" && active === "file" && !probe.available
			? probe.reason
			: undefined;

	// Check for dual-store conflicts without mutating anything.
	const conflictStores: Array<"auth" | "mcp_auth"> = [];
	const checkFileVsLegacy = async <T>(adapter: StoreAdapter<T>) => {
		try {
			const [cur, leg] = await Promise.all([
				readFileSlot(adapter.filePath(paths), adapter),
				readFileSlot(adapter.legacyFilePath(paths), adapter),
			]);
			if (
				cur.nonEmpty &&
				leg.nonEmpty &&
				!canonicalJsonEqual(cur.normalized, leg.normalized)
			) {
				conflictStores.push(adapter.name);
			}
		} catch {
			// Ignore parse failures here; reported when loading.
		}
	};
	await Promise.all([
		checkFileVsLegacy(options.authAdapter),
		checkFileVsLegacy(options.mcpAdapter),
	]);

	if (probe.available) {
		const checkKeychainVsFile = async <T>(adapter: StoreAdapter<T>) => {
			if (conflictStores.includes(adapter.name)) return;
			try {
				const [kc, cur] = await Promise.all([
					readKeychainSlot(keychain, adapter.service, account, adapter),
					readFileSlot(adapter.filePath(paths), adapter),
				]);
				if (
					kc.nonEmpty &&
					cur.nonEmpty &&
					!canonicalJsonEqual(kc.normalized, cur.normalized)
				) {
					conflictStores.push(adapter.name);
				}
			} catch {
				// Ignore errors during non-mutating status check.
			}
		};
		await Promise.all([
			checkKeychainVsFile(options.authAdapter),
			checkKeychainVsFile(options.mcpAdapter),
		]);
	}

	const state: "steady" | "migrating" | "conflict" =
		stateCorrupt || conflictStores.length > 0
			? "conflict"
			: storedState?.status === "migrating"
				? "migrating"
				: "steady";

	return {
		configured,
		active,
		state,
		...(fallbackReason ? { fallbackReason } : {}),
		mcpReauthRequired,
		conflictStores,
	};
};

export {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	CredentialConflictError,
	KeychainError,
};
