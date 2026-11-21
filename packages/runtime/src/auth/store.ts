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
	type AuthLockOptions,
	authLockPathFor,
	CredentialConflictError,
	canonicalJsonEqual,
	ensureStorageDirs,
	resolveStoragePaths,
	withAuthStoreLock,
	writeFileAtomic,
} from "@codelia/storage";

export type OAuthTokens = {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	account_id?: string;
};

export type ApiKeyCredential = {
	api_key: string;
	/** The built-in API base at credential acquisition, when known. */
	api_base?: string;
};

export type ProviderAuth =
	| ({
			method: "api_key";
	  } & ApiKeyCredential)
	| {
			method: "oauth";
			oauth: OAuthTokens;
	  };

/** Legacy v1 view retained for callers expecting single-method provider entries. */
export type AuthFile = {
	version: 1;
	providers: Record<string, ProviderAuth>;
};

export type ProviderAuthV2 = {
	chat_method?: "api_key" | "oauth";
	credentials: {
		api_key?: ApiKeyCredential;
		oauth?: OAuthTokens;
	};
};

export type AuthFileV2 = {
	version: 2;
	providers: Record<string, ProviderAuthV2>;
};

export const AUTH_VERSION_V1 = 1 as const;
export const AUTH_VERSION_V2 = 2 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeApiKey = (value: unknown): ApiKeyCredential | null => {
	if (!isRecord(value) || typeof value.api_key !== "string") return null;
	return {
		api_key: value.api_key,
		...(typeof value.api_base === "string" && value.api_base.length > 0
			? { api_base: value.api_base }
			: {}),
	};
};

const normalizeOAuth = (value: unknown): OAuthTokens | null => {
	if (
		!isRecord(value) ||
		typeof value.access_token !== "string" ||
		typeof value.refresh_token !== "string" ||
		typeof value.expires_at !== "number" ||
		!Number.isFinite(value.expires_at)
	) {
		return null;
	}
	return {
		access_token: value.access_token,
		refresh_token: value.refresh_token,
		expires_at: value.expires_at,
		...(typeof value.account_id === "string" && value.account_id.length > 0
			? { account_id: value.account_id }
			: {}),
	};
};

const normalizeProviderEntryV1 = (value: unknown): ProviderAuthV2 => {
	if (!isRecord(value)) {
		throw new Error("auth.json contains invalid provider entry");
	}
	if (value.method === "api_key") {
		const apiKey = normalizeApiKey(value);
		if (!apiKey) {
			throw new Error("auth.json contains invalid api_key entry");
		}
		return {
			chat_method: "api_key",
			credentials: { api_key: apiKey },
		};
	}
	if (value.method === "oauth") {
		const oauth = normalizeOAuth(value.oauth);
		if (!oauth) {
			throw new Error("auth.json contains invalid oauth entry");
		}
		return {
			chat_method: "oauth",
			credentials: { oauth },
		};
	}
	throw new Error("auth.json contains unsupported auth method");
};

const normalizeProviderEntryV2 = (value: unknown): ProviderAuthV2 => {
	if (!isRecord(value) || !isRecord(value.credentials)) {
		throw new Error("auth.json v2 contains invalid provider entry");
	}
	const chatMethod = value.chat_method;
	if (
		chatMethod !== undefined &&
		chatMethod !== "api_key" &&
		chatMethod !== "oauth"
	) {
		throw new Error("auth.json v2 contains invalid chat_method");
	}
	const credentials: ProviderAuthV2["credentials"] = {};
	if (value.credentials.api_key !== undefined) {
		const apiKey = normalizeApiKey(value.credentials.api_key);
		if (!apiKey) {
			throw new Error("auth.json v2 contains invalid api_key credential");
		}
		credentials.api_key = apiKey;
	}
	if (value.credentials.oauth !== undefined) {
		const oauth = normalizeOAuth(value.credentials.oauth);
		if (!oauth) {
			throw new Error("auth.json v2 contains invalid oauth credential");
		}
		credentials.oauth = oauth;
	}
	return {
		...(chatMethod ? { chat_method: chatMethod } : {}),
		credentials,
	};
};

export const parseAuthDocument = (
	text: string,
): { normalized: AuthFileV2; sourceVersion: 1 | 2 } => {
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("auth.json has unsupported format");
	}
	if (parsed.version === AUTH_VERSION_V1) {
		const rawProviders = isRecord(parsed.providers) ? parsed.providers : {};
		const providers: Record<string, ProviderAuthV2> = {};
		for (const [name, entry] of Object.entries(rawProviders)) {
			providers[name] = normalizeProviderEntryV1(entry);
		}
		return {
			normalized: { version: AUTH_VERSION_V2, providers },
			sourceVersion: 1,
		};
	}
	if (parsed.version === AUTH_VERSION_V2) {
		const rawProviders = isRecord(parsed.providers) ? parsed.providers : {};
		const providers: Record<string, ProviderAuthV2> = {};
		for (const [name, entry] of Object.entries(rawProviders)) {
			providers[name] = normalizeProviderEntryV2(entry);
		}
		return {
			normalized: { version: AUTH_VERSION_V2, providers },
			sourceVersion: 2,
		};
	}
	throw new Error("auth.json has unsupported version");
};

export const normalizeAuthFileToV2 = (
	auth: AuthFile | AuthFileV2,
): AuthFileV2 =>
	auth.version === AUTH_VERSION_V2
		? parseAuthDocument(JSON.stringify(auth)).normalized
		: parseAuthDocument(JSON.stringify(auth)).normalized;

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
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
};

export class AuthStore {
	private readonly paths: StoragePaths;
	private readonly lockOptions?: AuthLockOptions;

	constructor(paths?: StoragePaths, options?: { lock?: AuthLockOptions }) {
		this.paths = paths ?? resolveStoragePaths();
		this.lockOptions = options?.lock;
	}

	private lockPath(): string {
		return authLockPathFor(this.paths.credentialsDir);
	}

	/**
	 * Load normalized v2 credentials. Automatically migrates legacy root or v1
	 * files under the interprocess lock with pre-write conflict detection.
	 */
	async loadV2(): Promise<AuthFileV2> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.authFile),
			readTextIfPresent(this.paths.legacyAuthFile),
		]);
		if (legacyText !== null) {
			return this.migrateLegacyFileUnderLock();
		}
		if (currentText === null) {
			return { version: AUTH_VERSION_V2, providers: {} };
		}
		const parsed = parseAuthDocument(currentText);
		if (parsed.sourceVersion === 1) {
			return this.upgradeV1FileUnderLock();
		}
		return parsed.normalized;
	}

	private async loadV2Unlocked(): Promise<AuthFileV2> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.authFile),
			readTextIfPresent(this.paths.legacyAuthFile),
		]);
		if (legacyText !== null) {
			return this.migrateLegacyFileUnlocked();
		}
		if (currentText === null) {
			return { version: AUTH_VERSION_V2, providers: {} };
		}
		const parsed = parseAuthDocument(currentText);
		if (parsed.sourceVersion === 1) {
			await this.saveV2Unlocked(parsed.normalized);
		}
		return parsed.normalized;
	}

	private async upgradeV1FileUnderLock(): Promise<AuthFileV2> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const text = await readTextIfPresent(this.paths.authFile);
				if (text === null) return { version: AUTH_VERSION_V2, providers: {} };
				const parsed = parseAuthDocument(text);
				if (parsed.sourceVersion === 1) {
					await this.saveV2Unlocked(parsed.normalized);
				}
				return parsed.normalized;
			},
			this.lockOptions,
		);
	}

	private async migrateLegacyFileUnderLock(): Promise<AuthFileV2> {
		return withAuthStoreLock(
			this.lockPath(),
			() => this.migrateLegacyFileUnlocked(),
			this.lockOptions,
		);
	}

	private async migrateLegacyFileUnlocked(): Promise<AuthFileV2> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.authFile),
			readTextIfPresent(this.paths.legacyAuthFile),
		]);
		if (legacyText === null) {
			if (currentText === null) {
				return { version: AUTH_VERSION_V2, providers: {} };
			}
			return parseAuthDocument(currentText).normalized;
		}
		const legacyParsed = parseAuthDocument(legacyText);
		const legacyNonEmpty =
			Object.keys(legacyParsed.normalized.providers).length > 0;

		if (currentText !== null) {
			const currentParsed = parseAuthDocument(currentText);
			const currentNonEmpty =
				Object.keys(currentParsed.normalized.providers).length > 0;
			if (legacyNonEmpty && currentNonEmpty) {
				if (
					!canonicalJsonEqual(legacyParsed.normalized, currentParsed.normalized)
				) {
					throw new CredentialConflictError("auth");
				}
			}
			if (currentNonEmpty || !legacyNonEmpty) {
				await fs.unlink(this.paths.legacyAuthFile).catch(() => undefined);
				return currentParsed.normalized;
			}
		}

		await this.saveV2Unlocked(legacyParsed.normalized);
		const readBack = await readTextIfPresent(this.paths.authFile);
		if (
			readBack === null ||
			!canonicalJsonEqual(
				parseAuthDocument(readBack).normalized,
				legacyParsed.normalized,
			)
		) {
			throw new Error("auth migration read-back verification failed");
		}
		await fs.unlink(this.paths.legacyAuthFile);
		return legacyParsed.normalized;
	}

	/** Synchronous v2 snapshot for a one-use local approval consumed immediately before spawn. */
	loadForApprovalV2(): AuthFileV2 {
		for (const candidate of [this.paths.authFile, this.paths.legacyAuthFile]) {
			let fd: number;
			try {
				fd = openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK);
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
				throw error;
			}
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.size > 1024 * 1024)
					throw new Error("auth.json cannot be read at approval time");
				return parseAuthDocument(readFileSync(fd, "utf8")).normalized;
			} finally {
				closeSync(fd);
			}
		}
		return { version: AUTH_VERSION_V2, providers: {} };
	}

	/** Legacy v1-projected read view over the underlying v2 store. */
	async load(): Promise<AuthFile> {
		return projectAuthV2ToV1View(await this.loadV2());
	}

	/** Synchronous legacy v1-projected snapshot for approval checks. */
	loadForApproval(): AuthFile {
		return projectAuthV2ToV1View(this.loadForApprovalV2());
	}

	private async saveV2Unlocked(auth: AuthFileV2): Promise<void> {
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await writeFileAtomic(this.paths.authFile, data, { mode: 0o600 });
	}

	/**
	 * Reload v2, mutate, and atomically save under the interprocess SQLite lock.
	 * Skips writing if the serialized v2 document did not change.
	 */
	updateV2<T>(mutate: (auth: AuthFileV2) => T | Promise<T>): Promise<T> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const auth = await this.loadV2Unlocked();
				const before = JSON.stringify(auth);
				const result = await mutate(auth);
				if (JSON.stringify(auth) !== before) {
					await this.saveV2Unlocked(auth);
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

	/** Locked removal of every provider; works even if the file is unreadable. */
	clearAll(): Promise<void> {
		return withAuthStoreLock(
			this.lockPath(),
			() => this.saveV2Unlocked({ version: AUTH_VERSION_V2, providers: {} }),
			this.lockOptions,
		);
	}

	async saveV2(auth: AuthFileV2): Promise<void> {
		await withAuthStoreLock(
			this.lockPath(),
			() => this.saveV2Unlocked(auth),
			this.lockOptions,
		);
	}

	async save(auth: AuthFile | AuthFileV2): Promise<void> {
		const normalized = normalizeAuthFileToV2(auth);
		await this.saveV2(normalized);
	}
}
