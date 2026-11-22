import { promises as fs } from "node:fs";
import type { StoragePaths } from "@codelia/core";
import { writeFileAtomic } from "./atomic-file";
import {
	type AuthLockOptions,
	authLockPathFor,
	withAuthStoreLock,
} from "./auth-lock";
import { providerAuthStoreAdapter } from "./auth-schema";
import {
	type ConfiguredAuthStorageMode,
	coordinateCredentialBackendUnlocked,
	type StoreAdapter,
} from "./credential-backend";
import {
	readAuthStorageState,
	writeAuthStorageState,
} from "./credential-migration";
import {
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	type KeychainClient,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
} from "./macos-keychain";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";
import { verifyWindowsCredentialFileAcl } from "./windows-acl";

export type McpOAuthTokens = {
	access_token: string;
	refresh_token?: string;
	expires_at?: number;
	token_type?: string;
	scope?: string;
	client_id?: string;
	client_secret?: string;
};

export type McpServerAuthBinding = {
	/** Canonical MCP server / resource URI. */
	resource_uri: string;
	/** Canonical OAuth authorization server issuer (when known). */
	issuer?: string;
	/** Canonical OAuth token endpoint (when known). */
	token_endpoint?: string;
	/** OAuth client ID bound to the token (when known). */
	client_id?: string;
};

export type McpBoundServerAuth = {
	binding: McpServerAuthBinding;
	tokens: McpOAuthTokens;
};

export type McpAuthFile = {
	version: 2;
	servers: Record<string, McpBoundServerAuth>;
};

export const MCP_AUTH_VERSION = 2 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;

const pickNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Canonicalize an HTTP(S) URI for MCP resource and token endpoint comparisons.
 * Strips fragments, normalizes scheme/host casing, and drops default ports.
 */
export const canonicalizeMcpUri = (raw: string): string => {
	const parsed = new URL(raw.trim());
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported MCP URI scheme: ${parsed.protocol}`);
	}
	parsed.hash = "";
	parsed.hostname = parsed.hostname.toLowerCase();
	if (
		(parsed.protocol === "http:" && parsed.port === "80") ||
		(parsed.protocol === "https:" && parsed.port === "443")
	) {
		parsed.port = "";
	}
	return parsed.toString();
};

export const deriveMcpIssuer = (options: {
	issuer?: string;
	tokenUrl?: string;
	authorizationUrl?: string;
}): string | undefined => {
	// RFC 8414 issuer identifiers use exact string comparison, including the path.
	if (options.issuer?.trim()) return options.issuer;
	const endpoint = options.tokenUrl ?? options.authorizationUrl;
	if (!endpoint?.trim()) return undefined;
	try {
		return new URL(canonicalizeMcpUri(endpoint)).origin;
	} catch {
		return undefined;
	}
};

export const buildMcpAuthBinding = (options: {
	resourceUri: string;
	issuer?: string;
	tokenEndpoint?: string;
	clientId?: string;
}): McpServerAuthBinding => {
	const resource_uri = canonicalizeMcpUri(options.resourceUri);
	const issuer = deriveMcpIssuer({
		issuer: options.issuer,
		tokenUrl: options.tokenEndpoint,
	});
	const token_endpoint = options.tokenEndpoint?.trim()
		? canonicalizeMcpUri(options.tokenEndpoint)
		: undefined;
	const client_id = pickString(options.clientId);
	return {
		resource_uri,
		...(issuer ? { issuer } : {}),
		...(token_endpoint ? { token_endpoint } : {}),
		...(client_id ? { client_id } : {}),
	};
};

/**
 * Verify that a stored MCP token binding matches the currently resolved server
 * endpoint, OAuth issuer, token endpoint, and client ID (spec §9.4).
 *
 * Fail-closed: every binding attribute recorded on `stored` MUST be confirmed
 * on `resolved`. Missing issuer, token_endpoint, or client_id on `resolved`
 * when present on `stored` returns `false` and requires re-authentication.
 */
export const mcpAuthBindingMatches = (
	stored: McpServerAuthBinding,
	resolved: McpServerAuthBinding,
): boolean => {
	let storedResource: string;
	let resolvedResource: string;
	try {
		storedResource = canonicalizeMcpUri(stored.resource_uri);
		resolvedResource = canonicalizeMcpUri(resolved.resource_uri);
	} catch {
		return false;
	}
	if (storedResource !== resolvedResource) return false;

	if (stored.issuer) {
		const normStored = deriveMcpIssuer({ issuer: stored.issuer });
		const normResolved = resolved.issuer
			? deriveMcpIssuer({ issuer: resolved.issuer })
			: resolved.token_endpoint
				? deriveMcpIssuer({ tokenUrl: resolved.token_endpoint })
				: undefined;
		if (!normStored || !normResolved || normStored !== normResolved) {
			return false;
		}
	}

	if (stored.token_endpoint) {
		if (!resolved.token_endpoint) return false;
		try {
			if (
				canonicalizeMcpUri(stored.token_endpoint) !==
				canonicalizeMcpUri(resolved.token_endpoint)
			) {
				return false;
			}
		} catch {
			return false;
		}
	}

	if (stored.client_id) {
		if (!resolved.client_id || stored.client_id !== resolved.client_id) {
			return false;
		}
	}

	return true;
};

const normalizeTokens = (value: unknown): McpOAuthTokens | null => {
	if (!isRecord(value)) return null;
	const accessToken = pickString(value.access_token);
	if (!accessToken) return null;
	return {
		access_token: accessToken,
		...(pickString(value.refresh_token)
			? { refresh_token: pickString(value.refresh_token) }
			: {}),
		...(pickNumber(value.expires_at)
			? { expires_at: pickNumber(value.expires_at) }
			: {}),
		...(pickString(value.token_type)
			? { token_type: pickString(value.token_type) }
			: {}),
		...(pickString(value.scope) ? { scope: pickString(value.scope) } : {}),
		...(pickString(value.client_id)
			? { client_id: pickString(value.client_id) }
			: {}),
		...(pickString(value.client_secret)
			? { client_secret: pickString(value.client_secret) }
			: {}),
	};
};

const normalizeBinding = (value: unknown): McpServerAuthBinding | null => {
	if (!isRecord(value)) return null;
	const rawResource = pickString(value.resource_uri);
	if (!rawResource) return null;
	try {
		return buildMcpAuthBinding({
			resourceUri: rawResource,
			issuer: pickString(value.issuer),
			tokenEndpoint: pickString(value.token_endpoint),
			clientId: pickString(value.client_id),
		});
	} catch {
		return null;
	}
};

export const parseMcpAuthDocument = (
	text: string,
): {
	normalized: McpAuthFile;
	sourceVersion: 1 | 2;
	droppedLegacyServers: string[];
} => {
	const parsed = JSON.parse(text) as unknown;
	if (!isRecord(parsed)) {
		throw new Error("mcp-auth.json has unsupported format");
	}
	if (parsed.version === 1) {
		const serversRaw = isRecord(parsed.servers) ? parsed.servers : {};
		const droppedLegacyServers = Object.entries(serversRaw)
			.filter(([, entry]) => normalizeTokens(entry) !== null)
			.map(([id]) => id)
			.sort();
		return {
			normalized: { version: MCP_AUTH_VERSION, servers: {} },
			sourceVersion: 1,
			droppedLegacyServers,
		};
	}
	if (parsed.version !== MCP_AUTH_VERSION) {
		throw new Error("mcp-auth.json has unsupported version");
	}
	if (parsed.servers !== undefined && !isRecord(parsed.servers)) {
		throw new Error("mcp-auth.json v2 has invalid servers map");
	}
	const serversRaw = isRecord(parsed.servers) ? parsed.servers : {};
	const servers: Record<string, McpBoundServerAuth> = {};
	for (const [id, entry] of Object.entries(serversRaw)) {
		if (!isRecord(entry)) {
			throw new Error(`mcp-auth.json v2 has invalid entry for '${id}'`);
		}
		const binding = normalizeBinding(entry.binding);
		if (!binding) {
			throw new Error(`mcp-auth.json v2 has invalid binding for '${id}'`);
		}
		const tokens = normalizeTokens(entry.tokens);
		if (!tokens) {
			throw new Error(`mcp-auth.json v2 has invalid tokens for '${id}'`);
		}
		servers[id] = { binding, tokens };
	}
	return {
		normalized: { version: MCP_AUTH_VERSION, servers },
		sourceVersion: 2,
		droppedLegacyServers: [],
	};
};

export const mcpAuthStoreAdapter: StoreAdapter<McpAuthFile> = {
	name: "mcp_auth",
	service: CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	filePath: (paths: StoragePaths) => paths.mcpAuthFile,
	legacyFilePath: (paths: StoragePaths) => paths.legacyMcpAuthFile,
	empty: () => ({ version: MCP_AUTH_VERSION, servers: {} }),
	isNonEmpty: (doc) => Object.keys(doc.servers).length > 0,
	parse: (text) => {
		const parsed = parseMcpAuthDocument(text);
		return {
			normalized: parsed.normalized,
			sourceVersion: parsed.sourceVersion,
			extraWarnings: parsed.droppedLegacyServers,
		};
	},
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

export type McpAuthStoreOptions = {
	lock?: AuthLockOptions;
	storageMode?: ConfiguredAuthStorageMode;
	keychain?: KeychainClient;
};

export class McpAuthStore {
	private readonly paths: StoragePaths;
	private readonly lockOptions?: AuthLockOptions;
	private readonly storageMode?: ConfiguredAuthStorageMode;
	private readonly keychain: KeychainClient;

	constructor(paths?: StoragePaths, options?: McpAuthStoreOptions) {
		this.paths = paths ?? resolveStoragePaths();
		this.lockOptions = options?.lock;
		this.storageMode = options?.storageMode;
		this.keychain =
			options?.keychain ??
			new MacOsKeychainClient({ credentialsDir: this.paths.credentialsDir });
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

	private async recordDroppedLegacyServers(dropped: string[]): Promise<void> {
		if (!dropped.length) return;
		await ensureStorageDirs(this.paths);
		const existing = await readAuthStorageState(this.paths.authStateFile).catch(
			() => null,
		);
		const merged = [
			...new Set([...(existing?.mcp_reauth_required ?? []), ...dropped]),
		].sort();
		await writeAuthStorageState(this.paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: existing?.active_backend ?? "file",
			mcp_reauth_required: merged,
		});
	}

	private async readFromBackend(
		active: "file" | "keyring",
	): Promise<McpAuthFile> {
		if (active === "keyring") {
			const text = await this.keychain.get(
				CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
				this.keychainAccount(),
			);
			if (text === null) {
				return { version: MCP_AUTH_VERSION, servers: {} };
			}
			const parsed = parseMcpAuthDocument(text);
			if (parsed.sourceVersion === 1) {
				await this.writeToBackend("keyring", parsed.normalized);
				await this.recordDroppedLegacyServers(parsed.droppedLegacyServers);
			}
			return parsed.normalized;
		}
		const text = await readTextIfPresent(this.paths.mcpAuthFile);
		if (text === null) {
			return { version: MCP_AUTH_VERSION, servers: {} };
		}
		const parsed = parseMcpAuthDocument(text);
		if (parsed.sourceVersion === 1) {
			await this.writeToBackend("file", parsed.normalized);
			await this.recordDroppedLegacyServers(parsed.droppedLegacyServers);
		}
		return parsed.normalized;
	}

	private async clearReauthenticatedServers(
		authenticatedServers: readonly string[],
	): Promise<void> {
		if (!authenticatedServers.length) return;
		const existing = await readAuthStorageState(this.paths.authStateFile).catch(
			() => null,
		);
		if (!existing?.mcp_reauth_required?.length) return;
		const authenticated = new Set(authenticatedServers);
		const remaining = existing.mcp_reauth_required.filter(
			(id) => !authenticated.has(id),
		);
		if (remaining.length === existing.mcp_reauth_required.length) return;
		const { mcp_reauth_required: _prev, ...rest } = existing;
		await writeAuthStorageState(this.paths.authStateFile, {
			...rest,
			...(remaining.length ? { mcp_reauth_required: remaining } : {}),
		});
	}

	private async writeToBackend(
		active: "file" | "keyring",
		auth: McpAuthFile,
	): Promise<void> {
		if (active === "keyring") {
			await this.keychain.set(
				CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
				this.keychainAccount(),
				JSON.stringify(auth),
			);
			await this.clearReauthenticatedServers(Object.keys(auth.servers));
			return;
		}
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await writeFileAtomic(this.paths.mcpAuthFile, data, { mode: 0o600 });
		await this.clearReauthenticatedServers(Object.keys(auth.servers));
	}

	/**
	 * Load normalized v2 MCP auth from the active backend (macOS Keychain or
	 * protected `credentials/` file), running safe two-phase migration if needed.
	 */
	async load(): Promise<McpAuthFile> {
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
	 * Reload, mutate, and atomically save under the interprocess auth lock.
	 * Skips writing if the serialized document did not change.
	 */
	update<T>(mutate: (auth: McpAuthFile) => T | Promise<T>): Promise<T> {
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

	async save(auth: McpAuthFile): Promise<void> {
		await withAuthStoreLock(
			this.lockPath(),
			async () => {
				const resolved = await this.resolveBackendUnlocked();
				await this.writeToBackend(resolved.active, auth);
			},
			this.lockOptions,
		);
	}
}
