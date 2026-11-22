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
	type KeychainProbeResult,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
} from "./macos-keychain";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";
import { verifyWindowsCredentialFileAcl } from "./windows-acl";

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

const probeUnavailableError = (
	probe: Extract<KeychainProbeResult, { available: false }>,
	message = probe.message,
): KeychainError =>
	new KeychainError(
		probe.reason === "keychain_locked"
			? "keychain_locked"
			: "keychain_unavailable",
		message,
	);

const buildSteadyState = (
	activeBackend: CredentialBackendKind,
	mcpReauthRequired?: readonly string[],
): AuthStorageState => ({
	version: 1,
	status: "steady",
	active_backend: activeBackend,
	...(mcpReauthRequired?.length
		? { mcp_reauth_required: [...mcpReauthRequired] }
		: {}),
});

const isKeyringOwnedOrTargeting = (state: AuthStorageState | null): boolean =>
	state?.active_backend === "keyring" ||
	(state?.status === "migrating" && state.target_backend === "keyring");

const isKeyringInvolved = (state: AuthStorageState | null): boolean =>
	isKeyringOwnedOrTargeting(state) ||
	(state?.status === "migrating" &&
		state.cleanup_pending?.source_backend === "keyring");

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

const readTextIfPresent = async (
	filePath: string,
	legacy = false,
): Promise<string | null> => {
	if (!(await verifyWindowsCredentialFileAcl(filePath, legacy))) return null;
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
	legacy = false,
): Promise<{
	present: boolean;
	normalized: T;
	nonEmpty: boolean;
	sourceVersion?: 1 | 2;
	extraWarnings?: string[];
}> => {
	const text = await readTextIfPresent(filePath, legacy);
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

const makeFileDestHandlers = <T>(
	paths: StoragePaths,
	adapter: StoreAdapter<T>,
): Pick<StoreMigrationSlot<T>, "readDest" | "writeDest" | "verifyDest"> => {
	const destPath = adapter.filePath(paths);
	return {
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
	};
};

const makeFileFromKeychainSlot = <T>(
	paths: StoragePaths,
	keychain: KeychainClient,
	account: string,
	adapter: StoreAdapter<T>,
): StoreMigrationSlot<T> => ({
	name: adapter.name,
	readSource: () =>
		readKeychainSlot(keychain, adapter.service, account, adapter),
	...makeFileDestHandlers(paths, adapter),
	cleanupSource: async () => {
		await keychain.delete(adapter.service, account);
	},
});

const makeFileFromLegacySlot = <T>(
	paths: StoragePaths,
	adapter: StoreAdapter<T>,
): StoreMigrationSlot<T> => {
	const sourcePath = adapter.legacyFilePath(paths);
	return {
		name: adapter.name,
		readSource: () => readFileSlot(sourcePath, adapter, true),
		...makeFileDestHandlers(paths, adapter),
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

	if (
		pending.source_backend === "keyring" &&
		options.state.target_backend === "file"
	) {
		const probe = await options.keychain.probe();
		if (!probe.available) {
			throw probeUnavailableError(
				probe,
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
	} else if (pending.source_backend === "legacy_file") {
		if (pending.auth) {
			await unlinkIfPresent(options.authAdapter.legacyFilePath(options.paths));
		}
		if (pending.mcp_auth) {
			await unlinkIfPresent(options.mcpAdapter.legacyFilePath(options.paths));
		}
	} else {
		// source_backend === "file"
		const isLegacyCleanup = options.state.target_backend !== "keyring";
		const cleanupAuthPath = isLegacyCleanup
			? options.authAdapter.legacyFilePath(options.paths)
			: options.authAdapter.filePath(options.paths);
		const cleanupMcpPath = isLegacyCleanup
			? options.mcpAdapter.legacyFilePath(options.paths)
			: options.mcpAdapter.filePath(options.paths);
		if (pending.auth) {
			await unlinkIfPresent(cleanupAuthPath);
		}
		if (pending.mcp_auth) {
			await unlinkIfPresent(cleanupMcpPath);
		}
	}

	const committed = buildSteadyState(
		options.state.target_backend,
		options.state.mcp_reauth_required,
	);
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
	const keychain =
		options.keychain ??
		new MacOsKeychainClient({ credentialsDir: paths.credentialsDir });
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
			readTextIfPresent(authAdapter.legacyFilePath(paths), true),
			readTextIfPresent(mcpAdapter.legacyFilePath(paths), true),
		]);
		if (legacyAuth === null && legacyMcp === null) return;
		await runTwoPhaseMigration({
			stateFile: paths.authStateFile,
			fromBackend: state?.active_backend ?? "file",
			toBackend: state?.active_backend ?? "file",
			cleanupSourceKind: "legacy_file",
			authSlot: makeFileFromLegacySlot(paths, authAdapter),
			mcpSlot: makeFileFromLegacySlot(paths, mcpAdapter),
			existingMcpReauth: state?.mcp_reauth_required,
		});
		state = await readAuthStorageState(paths.authStateFile);
	};

	const keyringOwnedOrInFlight = isKeyringOwnedOrTargeting(state);

	if (configured === "file") {
		await migrateLegacyToCredentials();
		if (keyringOwnedOrInFlight) {
			// Explicit reverse migration / rollback (keyring -> file)
			const probe = await keychain.probe();
			if (!probe.available) {
				throw probeUnavailableError(
					probe,
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
			await writeAuthStorageState(
				paths.authStateFile,
				buildSteadyState("file", state?.mcp_reauth_required),
			);
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
			throw probeUnavailableError(probe);
		}
		// configured === "auto": NEVER silently fall back if Keychain already owns
		// credentials or a migration targeting Keychain was interrupted (spec §9.1).
		if (keyringOwnedOrInFlight) {
			throw probeUnavailableError(
				probe,
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
		await writeAuthStorageState(
			paths.authStateFile,
			buildSteadyState("keyring", state?.mcp_reauth_required),
		);
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
	const keychain =
		options.keychain ??
		new MacOsKeychainClient({ credentialsDir: paths.credentialsDir });
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
		if (isKeyringInvolved(storedState)) {
			throw probeUnavailableError(
				probe,
				`Cannot clear Keychain credentials while Keychain is unavailable (${probe.reason}): ${probe.message}`,
			);
		}
	}
};

type ConflictStoreContext = {
	paths: StoragePaths;
	keychain: KeychainClient;
	account: string;
	configured: ConfiguredAuthStorageMode;
	existingState: AuthStorageState | null;
};

const resolveDefaultTargetBackend = async (
	configured: ConfiguredAuthStorageMode,
	keychain: KeychainClient,
): Promise<CredentialBackendKind> => {
	if (configured === "file") return "file";
	if (configured === "keyring") return "keyring";
	return (await keychain.probe()).available ? "keyring" : "file";
};

const resolveKeepKeyringStore = async <T>(
	ctx: ConflictStoreContext,
	adapter: StoreAdapter<T>,
): Promise<void> => {
	const probe = await ctx.keychain.probe();
	if (!probe.available) {
		throw probeUnavailableError(
			probe,
			`Cannot keep Keychain credentials while Keychain is unavailable: ${probe.message}`,
		);
	}
	// Verify Keychain payload exists and is non-empty whenever file/legacy has credentials.
	const slot = await readKeychainSlot(
		ctx.keychain,
		adapter.service,
		ctx.account,
		adapter,
	);
	const fileSlot = await readFileSlot(
		adapter.filePath(ctx.paths),
		adapter,
	).catch(() => ({ present: true, nonEmpty: true }));
	const legacySlot = await readFileSlot(
		adapter.legacyFilePath(ctx.paths),
		adapter,
		true,
	).catch(() => ({ present: true, nonEmpty: true }));
	if (!slot.present && !fileSlot.present && !legacySlot.present) {
		return;
	}
	if (
		!slot.present ||
		(!slot.nonEmpty && (fileSlot.nonEmpty || legacySlot.nonEmpty))
	) {
		throw new Error(
			`Cannot keep Keychain store for '${adapter.name}': Keychain has no saved credentials`,
		);
	}
	await unlinkIfPresent(adapter.filePath(ctx.paths));
	await unlinkIfPresent(adapter.legacyFilePath(ctx.paths));
};

const resolveKeepFileStore = async <T>(
	ctx: ConflictStoreContext,
	adapter: StoreAdapter<T>,
): Promise<void> => {
	// Verify protected file parses cleanly before removing competing copies.
	const slot = await readFileSlot(adapter.filePath(ctx.paths), adapter);
	if (!slot.present) {
		throw new Error(
			`Cannot keep file store for '${adapter.name}': ${adapter.filePath(ctx.paths)} does not exist`,
		);
	}
	await writeFileAtomic(
		adapter.filePath(ctx.paths),
		JSON.stringify(slot.normalized, null, 2),
		{ mode: 0o600 },
	);
	await unlinkIfPresent(adapter.legacyFilePath(ctx.paths));
	const probe = await ctx.keychain.probe();
	if (probe.available) {
		await ctx.keychain.delete(adapter.service, ctx.account);
	} else if (ctx.existingState?.active_backend === "keyring") {
		throw probeUnavailableError(
			probe,
			`Cannot remove superseded Keychain entry while Keychain is unavailable: ${probe.message}`,
		);
	}
};

const resolveKeepLegacyStore = async <T>(
	ctx: ConflictStoreContext,
	adapter: StoreAdapter<T>,
): Promise<void> => {
	const legacy = await readFileSlot(
		adapter.legacyFilePath(ctx.paths),
		adapter,
		true,
	);
	if (!legacy.present) {
		throw new Error(
			`Cannot keep legacy store for '${adapter.name}': ${adapter.legacyFilePath(ctx.paths)} does not exist`,
		);
	}
	const targetBackend = await resolveDefaultTargetBackend(
		ctx.configured,
		ctx.keychain,
	);
	if (targetBackend === "keyring") {
		const probe = await ctx.keychain.probe();
		if (!probe.available) {
			throw probeUnavailableError(
				probe,
				`Cannot promote legacy store to Keychain while Keychain is unavailable: ${probe.message}`,
			);
		}
		await ctx.keychain.set(
			adapter.service,
			ctx.account,
			JSON.stringify(legacy.normalized),
		);
		const verify = await readKeychainSlot(
			ctx.keychain,
			adapter.service,
			ctx.account,
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
		await unlinkIfPresent(adapter.filePath(ctx.paths));
		await unlinkIfPresent(adapter.legacyFilePath(ctx.paths));
		return;
	}
	await writeFileAtomic(
		adapter.filePath(ctx.paths),
		JSON.stringify(legacy.normalized, null, 2),
		{ mode: 0o600 },
	);
	await unlinkIfPresent(adapter.legacyFilePath(ctx.paths));
	const probe = await ctx.keychain.probe();
	if (probe.available) {
		await ctx.keychain.delete(adapter.service, ctx.account);
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
	const keychain =
		options.keychain ??
		new MacOsKeychainClient({ credentialsDir: paths.credentialsDir });
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
			const ctx: ConflictStoreContext = {
				paths,
				keychain,
				account,
				configured,
				existingState,
			};

			const resolveOne = async <T>(adapter: StoreAdapter<T>): Promise<void> => {
				switch (options.strategy) {
					case "clear_all":
						await clearStoreAcrossAllLocationsUnlocked({
							paths,
							adapter,
							keychain,
						});
						return;
					case "keep_keyring":
						await resolveKeepKeyringStore(ctx, adapter);
						return;
					case "keep_file":
						await resolveKeepFileStore(ctx, adapter);
						return;
					case "keep_legacy":
						await resolveKeepLegacyStore(ctx, adapter);
						return;
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
						: await resolveDefaultTargetBackend(configured, keychain);

			await writeAuthStorageState(
				paths.authStateFile,
				buildSteadyState(targetActive, existingState?.mcp_reauth_required),
			);

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
	/** Invoked only for an unambiguous, steady snapshot. Never serialized by storage. */
	onReadableAuth?: (doc: TAuth) => void;
}): Promise<{
	configured: ConfiguredAuthStorageMode;
	active: CredentialBackendKind;
	state: "steady" | "migrating" | "conflict";
	fallbackReason?: AuthStorageFallbackReason;
	mcpReauthRequired: string[];
	conflictStores: Array<"auth" | "mcp_auth">;
	unreadableStores: Array<"auth" | "mcp_auth" | "storage_state">;
	keychainIssue?:
		| "keychain_locked"
		| "keychain_access_denied"
		| "keychain_unavailable";
}> => {
	const paths = options.paths ?? resolveStoragePaths();
	const keychain =
		options.keychain ??
		new MacOsKeychainClient({
			credentialsDir: paths.credentialsDir,
		});
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

	const keyringOwned = isKeyringInvolved(storedState);

	const shouldProbeKeychain = configured !== "file" || keyringOwned;
	const probe = shouldProbeKeychain
		? await keychain.probe()
		: {
				available: false as const,
				reason: "keychain_unavailable" as const,
				message: "file mode selected",
			};

	type ItemIssue =
		| "keychain_locked"
		| "keychain_access_denied"
		| "keychain_unavailable";
	const inspectStore = async <T>(adapter: StoreAdapter<T>) => {
		let issue: ItemIssue | undefined;
		const inspectKeychain = async () => {
			if (!probe.available) {
				if (keyringOwned || configured === "keyring") {
					issue =
						probe.reason === "keychain_locked"
							? "keychain_locked"
							: "keychain_unavailable";
				}
				return null;
			}
			try {
				return await readKeychainSlot(
					keychain,
					adapter.service,
					account,
					adapter,
				);
			} catch (error) {
				if (!(error instanceof KeychainError)) throw error;
				issue =
					error.code === "keychain_locked" ||
					error.code === "keychain_access_denied"
						? error.code
						: "keychain_unavailable";
				return null;
			}
		};
		const [current, legacy, native] = await Promise.all([
			readFileSlot(adapter.filePath(paths), adapter),
			readFileSlot(adapter.legacyFilePath(paths), adapter, true),
			inspectKeychain(),
		]);
		const file = current.nonEmpty ? current : legacy;
		const conflict =
			(current.nonEmpty &&
				legacy.nonEmpty &&
				!canonicalJsonEqual(current.normalized, legacy.normalized)) ||
			(file.nonEmpty &&
				native?.nonEmpty &&
				!canonicalJsonEqual(file.normalized, native.normalized));
		return { file, native, conflict, issue };
	};
	const [auth, mcp] = await Promise.all([
		inspectStore(options.authAdapter).catch(() => null),
		inspectStore(options.mcpAdapter).catch(() => null),
	]);
	const keychainIssue = auth?.issue ?? mcp?.issue;
	const unreadableStores: Array<"auth" | "mcp_auth" | "storage_state"> = [];
	if (!auth) unreadableStores.push("auth");
	if (!mcp) unreadableStores.push("mcp_auth");
	if (stateCorrupt) unreadableStores.push("storage_state");
	const conflictStores: Array<"auth" | "mcp_auth"> = [];
	if (auth?.conflict) conflictStores.push("auth");
	if (mcp?.conflict) conflictStores.push("mcp_auth");
	const state =
		stateCorrupt || conflictStores.length > 0
			? "conflict"
			: (storedState?.status ?? "steady");
	// Show the backend that currently owns the data, even when the next write
	// would migrate it to the configured backend.
	const active: CredentialBackendKind =
		storedState?.active_backend ??
		(auth?.file.nonEmpty || mcp?.file.nonEmpty
			? "file"
			: probe.available || configured === "keyring"
				? "keyring"
				: "file");
	const fallbackReason =
		configured === "auto" && active === "file" && !probe.available
			? probe.reason
			: undefined;
	if (state === "steady" && auth && !auth.issue) {
		const snapshot = active === "file" ? auth.file : auth.native;
		if (snapshot?.nonEmpty) options.onReadableAuth?.(snapshot.normalized);
	}

	return {
		configured,
		active,
		state,
		...(fallbackReason ? { fallbackReason } : {}),
		mcpReauthRequired,
		conflictStores,
		unreadableStores,
		...(keychainIssue ? { keychainIssue } : {}),
	};
};

export {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	CredentialConflictError,
	KeychainError,
};
