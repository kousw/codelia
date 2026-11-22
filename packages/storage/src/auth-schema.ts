import type { StoragePaths } from "@codelia/core";
import type { StoreAdapter } from "./credential-backend";
import { CODELIA_AUTH_KEYCHAIN_SERVICE } from "./macos-keychain";

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

export const providerAuthStoreAdapter: StoreAdapter<AuthFileV2> = {
	name: "auth",
	service: CODELIA_AUTH_KEYCHAIN_SERVICE,
	filePath: (paths: StoragePaths) => paths.authFile,
	legacyFilePath: (paths: StoragePaths) => paths.legacyAuthFile,
	empty: () => ({ version: AUTH_VERSION_V2, providers: {} }),
	isNonEmpty: (doc) => Object.keys(doc.providers).length > 0,
	parse: (text) => parseAuthDocument(text),
};
