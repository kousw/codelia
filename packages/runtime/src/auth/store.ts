import {
	closeSync,
	constants,
	promises as fs,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
import type { StoragePaths } from "@codelia/core";
import {
	type ApiKeyCredential,
	AUTH_VERSION_V1,
	AUTH_VERSION_V2,
	type AuthFile,
	type AuthFileV2,
	type AuthLockOptions,
	authLockPathFor,
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	type ConfiguredAuthStorageMode,
	CredentialConflictError,
	canonicalJsonEqual,
	clearStoreAcrossAllLocationsUnlocked,
	coordinateCredentialBackendUnlocked,
	ensureStorageDirs,
	type KeychainClient,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
	mcpAuthStoreAdapter,
	type OAuthTokens,
	type ProviderAuth,
	type ProviderAuthV2,
	parseAuthDocument,
	providerAuthStoreAdapter,
	readAuthStorageStateSync,
	resolveConfiguredAuthStorageMode,
	resolveStoragePaths,
	verifyWindowsCredentialFileAcl,
	verifyWindowsCredentialFileAclSync,
	withAuthStoreLock,
	writeFileAtomic,
} from "@codelia/storage";

export {
	type ApiKeyCredential,
	AUTH_VERSION_V1,
	AUTH_VERSION_V2,
	type AuthFile,
	type AuthFileV2,
	type OAuthTokens,
	type ProviderAuth,
	type ProviderAuthV2,
	parseAuthDocument,
};

export const normalizeAuthFileToV2 = (
	auth: AuthFile | AuthFileV2,
): AuthFileV2 => parseAuthDocument(JSON.stringify(auth)).normalized;

/** Resolve the active chat auth for `provider` (respecting `chat_method`). */
export const getChatProviderAuth = (
	auth: AuthFileV2,
	provider: string,
): ProviderAuth | undefined => {
	if (!Object.hasOwn(auth.providers, provider)) return undefined;
	const entry = auth.providers[provider];
	if (entry.chat_method === "oauth" && entry.credentials.oauth) {
		return { method: "oauth", oauth: entry.credentials.oauth };
	}
	if (entry.chat_method === "api_key" && entry.credentials.api_key) {
		return { method: "api_key", ...entry.credentials.api_key };
	}
	return undefined;
};

/** Resolve stored API key for `provider`, regardless of selected `chat_method`. */
export const getStoredProviderApiKey = (
	auth: AuthFileV2,
	provider: string,
): ApiKeyCredential | undefined =>
	Object.hasOwn(auth.providers, provider)
		? auth.providers[provider].credentials.api_key
		: undefined;

/** Resolve stored OAuth tokens for `provider`, regardless of `chat_method`. */
export const getStoredProviderOAuth = (
	auth: AuthFileV2,
	provider: string,
): OAuthTokens | undefined =>
	Object.hasOwn(auth.providers, provider)
		? auth.providers[provider].credentials.oauth
		: undefined;

/** Set chat auth for `provider`, preserving any coexisting credential of the other method. */
export const setProviderChatAuth = (
	auth: AuthFileV2,
	provider: string,
	next: ProviderAuth,
): void => {
	const existing = Object.hasOwn(auth.providers, provider)
		? auth.providers[provider]
		: undefined;
	const credentials: ProviderAuthV2["credentials"] = {
		...(existing?.credentials ?? {}),
	};
	if (next.method === "api_key") {
		credentials.api_key = {
			api_key: next.api_key,
			...(next.api_base ? { api_base: next.api_base } : {}),
		};
	} else {
		credentials.oauth = next.oauth;
	}
	auth.providers[provider] = {
		chat_method: next.method,
		credentials,
	};
};

/** Save an API key for `provider` without altering OAuth or `chat_method` unless requested. */
export const setProviderApiKey = (
	auth: AuthFileV2,
	provider: string,
	credential: ApiKeyCredential,
	options?: { selectForChat?: boolean },
): void => {
	const existing = Object.hasOwn(auth.providers, provider)
		? auth.providers[provider]
		: undefined;
	const chatMethod = options?.selectForChat ? "api_key" : existing?.chat_method;
	auth.providers[provider] = {
		...(chatMethod ? { chat_method: chatMethod } : {}),
		credentials: {
			...(existing?.credentials ?? {}),
			api_key: {
				api_key: credential.api_key,
				...(credential.api_base ? { api_base: credential.api_base } : {}),
			},
		},
	};
};

/**
 * Update only the OAuth slot during token rotation. Preserves any coexisting
 * API key and chat_method, and refuses to resurrect a concurrently removed entry.
 */
export const updateProviderOAuthTokens = (
	auth: AuthFileV2,
	provider: string,
	oauth: OAuthTokens,
): boolean => {
	if (!Object.hasOwn(auth.providers, provider)) return false;
	const entry = auth.providers[provider];
	if (!entry.credentials.oauth) return false;
	auth.providers[provider] = {
		...(entry.chat_method ? { chat_method: entry.chat_method } : {}),
		credentials: {
			...entry.credentials,
			oauth,
		},
	};
	return true;
};

/** Remove one credential method without auto-falling back `chat_method` to the remaining slot. */
export const clearProviderMethod = (
	auth: AuthFileV2,
	provider: string,
	method: "api_key" | "oauth",
): void => {
	if (!Object.hasOwn(auth.providers, provider)) return;
	const entry = auth.providers[provider];
	const nextCredentials: ProviderAuthV2["credentials"] = {
		...entry.credentials,
	};
	delete nextCredentials[method];
	if (!nextCredentials.api_key && !nextCredentials.oauth) {
		delete auth.providers[provider];
		return;
	}
	const nextChatMethod =
		entry.chat_method === method ? undefined : entry.chat_method;
	auth.providers[provider] = {
		...(nextChatMethod ? { chat_method: nextChatMethod } : {}),
		credentials: nextCredentials,
	};
};

export const clearProviderEntry = (
	auth: AuthFileV2,
	provider: string,
): void => {
	delete auth.providers[provider];
};

/** Project v2 auth to the single-method chat view for v1 compatibility callers. */
export const projectAuthV2ToV1View = (auth: AuthFileV2): AuthFile => {
	const providers: Record<string, ProviderAuth> = {};
	for (const name of Object.keys(auth.providers)) {
		const chatAuth = getChatProviderAuth(auth, name);
		if (chatAuth) {
			providers[name] = chatAuth;
		}
	}
	return { version: AUTH_VERSION_V1, providers };
};

const readTextIfPresent = async (filePath: string): Promise<string | null> => {
	if (!(await verifyWindowsCredentialFileAcl(filePath))) return null;
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
};

const readAuthFileSyncStrict = (
	filePath: string,
	legacy = false,
): AuthFileV2 | null => {
	if (!verifyWindowsCredentialFileAclSync(filePath, legacy)) return null;
	let fd: number;
	try {
		fd = openSync(
			filePath,
			constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 1024 * 1024) {
			throw new Error("auth.json cannot be read at approval time");
		}
		return parseAuthDocument(readFileSync(fd, "utf8")).normalized;
	} finally {
		closeSync(fd);
	}
};

const isAuthNonEmpty = (doc: AuthFileV2 | null): doc is AuthFileV2 =>
	doc !== null && Object.keys(doc.providers).length > 0;

export type AuthStoreOptions = {
	lock?: AuthLockOptions;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
	untrustedHelperRoots?: readonly string[];
};

export class AuthStore {
	private readonly paths: StoragePaths;
	private readonly lockOptions?: AuthLockOptions;
	private readonly storageMode?: ConfiguredAuthStorageMode;
	private readonly keychain: KeychainClient;

	constructor(paths?: StoragePaths, options?: AuthStoreOptions) {
		this.paths = paths ?? resolveStoragePaths();
		this.lockOptions = options?.lock;
		this.storageMode = options?.storageMode;
		this.keychain =
			options?.keychain ??
			new MacOsKeychainClient({
				untrustedRoots: options?.untrustedHelperRoots,
			});
	}

	private lockPath(): string {
		return authLockPathFor(this.paths.credentialsDir);
	}

	private keychainAccount(): string {
		return keychainAccountForConfigDir(this.paths.configDir);
	}

	private resolveBackendUnlocked() {
		return coordinateCredentialBackendUnlocked({
			paths: this.paths,
			storageMode: this.storageMode,
			keychain: this.keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
	}

	private async readFromBackend(
		active: "file" | "keyring",
	): Promise<AuthFileV2> {
		if (active === "keyring") {
			const text = await this.keychain.get(
				CODELIA_AUTH_KEYCHAIN_SERVICE,
				this.keychainAccount(),
			);
			if (text === null) {
				return { version: AUTH_VERSION_V2, providers: {} };
			}
			const parsed = parseAuthDocument(text);
			if (parsed.sourceVersion === 1) {
				await this.writeToBackend("keyring", parsed.normalized);
			}
			return parsed.normalized;
		}
		const text = await readTextIfPresent(this.paths.authFile);
		if (text === null) {
			return { version: AUTH_VERSION_V2, providers: {} };
		}
		const parsed = parseAuthDocument(text);
		if (parsed.sourceVersion === 1) {
			await this.writeToBackend("file", parsed.normalized);
		}
		return parsed.normalized;
	}

	private async writeToBackend(
		active: "file" | "keyring",
		auth: AuthFileV2,
	): Promise<void> {
		if (active === "keyring") {
			await this.keychain.set(
				CODELIA_AUTH_KEYCHAIN_SERVICE,
				this.keychainAccount(),
				JSON.stringify(auth),
			);
			return;
		}
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await writeFileAtomic(this.paths.authFile, data, { mode: 0o600 });
	}

	/**
	 * Load normalized v2 credentials from the active backend (macOS Keychain or
	 * protected `credentials/` file), running two-phase migration if needed.
	 */
	async loadV2(): Promise<AuthFileV2> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const resolved = await this.resolveBackendUnlocked();
				return this.readFromBackend(resolved.active);
			},
			this.lockOptions,
		);
	}

	/**
	 * Synchronous v2 snapshot for a one-use local approval consumed immediately
	 * before spawn. Fails closed (throws) on corrupt `storage-state.json`,
	 * in-progress migrations or pending cleanup, dual-store conflicts, or
	 * locked/unavailable/timed-out Keychain access.
	 */
	loadForApprovalV2(): AuthFileV2 {
		const configured = resolveConfiguredAuthStorageMode(
			this.paths,
			this.storageMode,
		);
		const state = readAuthStorageStateSync(this.paths.authStateFile);
		if (state?.status === "migrating") {
			throw new Error(
				"Credential storage migration is in progress; approval-time auth is unavailable",
			);
		}
		if (configured === "file" && state?.active_backend === "keyring") {
			throw new Error(
				"Credential reverse migration to file is pending; approval-time auth is unavailable",
			);
		}
		const useKeychain =
			configured === "keyring" ||
			(configured === "auto" && state?.active_backend === "keyring");

		const currentFile = readAuthFileSyncStrict(this.paths.authFile);
		const legacyFile = readAuthFileSyncStrict(this.paths.legacyAuthFile, true);
		if (
			isAuthNonEmpty(currentFile) &&
			isAuthNonEmpty(legacyFile) &&
			!canonicalJsonEqual(currentFile, legacyFile)
		) {
			throw new CredentialConflictError("auth");
		}

		if (useKeychain) {
			const text = this.keychain.getSync(
				CODELIA_AUTH_KEYCHAIN_SERVICE,
				this.keychainAccount(),
				2_000,
			);
			const keychainDoc: AuthFileV2 =
				text === null
					? { version: AUTH_VERSION_V2, providers: {} }
					: parseAuthDocument(text).normalized;
			for (const fileCandidate of [currentFile, legacyFile]) {
				if (
					isAuthNonEmpty(fileCandidate) &&
					isAuthNonEmpty(keychainDoc) &&
					!canonicalJsonEqual(keychainDoc, fileCandidate)
				) {
					throw new CredentialConflictError("auth");
				}
			}
			return keychainDoc;
		}

		if (isAuthNonEmpty(currentFile)) return currentFile;
		if (isAuthNonEmpty(legacyFile)) return legacyFile;
		return (
			currentFile ?? legacyFile ?? { version: AUTH_VERSION_V2, providers: {} }
		);
	}

	/** Legacy v1-projected read view over the underlying v2 store. */
	async load(): Promise<AuthFile> {
		return projectAuthV2ToV1View(await this.loadV2());
	}

	/** Synchronous legacy v1-projected snapshot for approval checks. */
	loadForApproval(): AuthFile {
		return projectAuthV2ToV1View(this.loadForApprovalV2());
	}

	/**
	 * Reload v2, mutate, and atomically save under the interprocess SQLite lock.
	 * Skips writing if the serialized v2 document did not change.
	 */
	updateV2<T>(mutate: (auth: AuthFileV2) => T | Promise<T>): Promise<T> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const resolved = await this.resolveBackendUnlocked();
				const auth = await this.readFromBackend(resolved.active);
				const before = JSON.stringify(auth);
				const result = await mutate(auth);
				if (JSON.stringify(auth) !== before) {
					await this.writeToBackend(resolved.active, auth);
				}
				return result;
			},
			this.lockOptions,
		);
	}

	/**
	 * Legacy v1-projected update helper. Applies v1 mutations onto the underlying
	 * v2 document while preserving coexisting credentials on untouched slots.
	 */
	update<T>(mutate: (auth: AuthFile) => T | Promise<T>): Promise<T> {
		return this.updateV2(async (v2) => {
			const beforeView = projectAuthV2ToV1View(v2);
			const workingView: AuthFile = {
				version: AUTH_VERSION_V1,
				providers: { ...beforeView.providers },
			};
			const result = await mutate(workingView);
			const touched = new Set([
				...Object.keys(beforeView.providers),
				...Object.keys(workingView.providers),
			]);
			for (const name of touched) {
				const had = Object.hasOwn(beforeView.providers, name);
				const has = Object.hasOwn(workingView.providers, name);
				if (!has && had) {
					clearProviderEntry(v2, name);
				} else if (has) {
					const next = workingView.providers[name];
					if (!had || !canonicalJsonEqual(beforeView.providers[name], next)) {
						setProviderChatAuth(v2, name, next);
					}
				}
			}
			return result;
		});
	}

	/**
	 * Locked removal of every provider across all credential locations
	 * (`credentials/auth.json`, legacy `auth.json`, and Keychain if active/reachable).
	 * Succeeds even when an `auth` storage conflict or corrupt file exists so
	 * full logout always gives users a clean recovery path (never touches `mcp-auth`).
	 */
	clearAll(): Promise<void> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				await clearStoreAcrossAllLocationsUnlocked({
					paths: this.paths,
					adapter: providerAuthStoreAdapter,
					keychain: this.keychain,
				});
			},
			this.lockOptions,
		);
	}

	async saveV2(auth: AuthFileV2): Promise<void> {
		await withAuthStoreLock(
			this.lockPath(),
			async () => {
				const resolved = await this.resolveBackendUnlocked();
				await this.writeToBackend(resolved.active, auth);
			},
			this.lockOptions,
		);
	}

	async save(auth: AuthFile | AuthFileV2): Promise<void> {
		const normalized = normalizeAuthFileToV2(auth);
		await this.saveV2(normalized);
	}
}
