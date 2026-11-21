import { promises as fs } from "node:fs";
import type { StoragePaths } from "@codelia/core";
import { writeFileAtomic } from "./atomic-file";
import {
	type AuthLockOptions,
	authLockPathFor,
	withAuthStoreLock,
} from "./auth-lock";
import {
	CredentialConflictError,
	canonicalJsonEqual,
	readAuthStorageState,
	writeAuthStorageState,
} from "./credential-migration";
import { ensureStorageDirs, resolveStoragePaths } from "./paths";

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
 * Canonicalize an HTTP(S) URI for MCP endpoint / issuer binding comparisons.
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
	if (options.issuer?.trim()) {
		try {
			return canonicalizeMcpUri(options.issuer).replace(/\/+$/u, "");
		} catch {
			return options.issuer.trim();
		}
	}
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

	if (stored.issuer && resolved.issuer) {
		const normStored = deriveMcpIssuer({ issuer: stored.issuer });
		const normResolved = deriveMcpIssuer({ issuer: resolved.issuer });
		if (normStored !== normResolved) return false;
	} else if (stored.issuer && !resolved.issuer) {
		// Stored token is bound to an issuer; if resolved has token_endpoint, verify origin.
		if (resolved.token_endpoint) {
			const derived = deriveMcpIssuer({ tokenUrl: resolved.token_endpoint });
			if (derived !== deriveMcpIssuer({ issuer: stored.issuer })) return false;
		}
	}

	if (stored.token_endpoint && resolved.token_endpoint) {
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

	if (stored.client_id && resolved.client_id) {
		if (stored.client_id !== resolved.client_id) return false;
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
		// v1 entries lack endpoint/issuer bindings; per spec §9.4 they must not be
		// replayed to unverified endpoints and require fresh authorization.
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
	const serversRaw = isRecord(parsed.servers) ? parsed.servers : {};
	const servers: Record<string, McpBoundServerAuth> = {};
	for (const [id, entry] of Object.entries(serversRaw)) {
		if (!isRecord(entry)) continue;
		const binding = normalizeBinding(entry.binding);
		const tokens = normalizeTokens(entry.tokens);
		if (binding && tokens) {
			servers[id] = { binding, tokens };
		}
	}
	return {
		normalized: { version: MCP_AUTH_VERSION, servers },
		sourceVersion: 2,
		droppedLegacyServers: [],
	};
};

const readTextIfPresent = async (filePath: string): Promise<string | null> => {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
};

export class McpAuthStore {
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
	 * Load normalized v2 MCP auth. If a legacy root file or v1 file is present,
	 * migrates safely under the interprocess lock with pre-write conflict checks.
	 */
	async load(): Promise<McpAuthFile> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.mcpAuthFile),
			readTextIfPresent(this.paths.legacyMcpAuthFile),
		]);

		if (legacyText !== null) {
			return this.migrateLegacyFileUnderLock();
		}
		if (currentText === null) {
			return { version: MCP_AUTH_VERSION, servers: {} };
		}
		const parsed = parseMcpAuthDocument(currentText);
		if (parsed.sourceVersion === 1) {
			return this.upgradeV1FileUnderLock();
		}
		return parsed.normalized;
	}

	private async loadUnlocked(): Promise<McpAuthFile> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.mcpAuthFile),
			readTextIfPresent(this.paths.legacyMcpAuthFile),
		]);
		if (legacyText !== null) {
			return this.migrateLegacyFileUnlocked();
		}
		if (currentText === null) {
			return { version: MCP_AUTH_VERSION, servers: {} };
		}
		const parsed = parseMcpAuthDocument(currentText);
		if (parsed.sourceVersion === 1) {
			await this.saveUnlocked(parsed.normalized);
			await this.recordDroppedLegacyServers(parsed.droppedLegacyServers);
		}
		return parsed.normalized;
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

	private async upgradeV1FileUnderLock(): Promise<McpAuthFile> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const text = await readTextIfPresent(this.paths.mcpAuthFile);
				if (text === null) return { version: MCP_AUTH_VERSION, servers: {} };
				const parsed = parseMcpAuthDocument(text);
				if (parsed.sourceVersion === 1) {
					await this.saveUnlocked(parsed.normalized);
					await this.recordDroppedLegacyServers(parsed.droppedLegacyServers);
				}
				return parsed.normalized;
			},
			this.lockOptions,
		);
	}

	private async migrateLegacyFileUnderLock(): Promise<McpAuthFile> {
		return withAuthStoreLock(
			this.lockPath(),
			() => this.migrateLegacyFileUnlocked(),
			this.lockOptions,
		);
	}

	private async migrateLegacyFileUnlocked(): Promise<McpAuthFile> {
		const [currentText, legacyText] = await Promise.all([
			readTextIfPresent(this.paths.mcpAuthFile),
			readTextIfPresent(this.paths.legacyMcpAuthFile),
		]);
		if (legacyText === null) {
			if (currentText === null) {
				return { version: MCP_AUTH_VERSION, servers: {} };
			}
			return parseMcpAuthDocument(currentText).normalized;
		}
		const legacyParsed = parseMcpAuthDocument(legacyText);
		const legacyNonEmpty =
			Object.keys(legacyParsed.normalized.servers).length > 0;

		if (currentText !== null) {
			const currentParsed = parseMcpAuthDocument(currentText);
			const currentNonEmpty =
				Object.keys(currentParsed.normalized.servers).length > 0;
			if (legacyNonEmpty && currentNonEmpty) {
				if (
					!canonicalJsonEqual(legacyParsed.normalized, currentParsed.normalized)
				) {
					throw new CredentialConflictError("mcp_auth");
				}
			}
			// Identical or legacy had only dropped unbound v1 entries: keep current.
			await this.recordDroppedLegacyServers(legacyParsed.droppedLegacyServers);
			await fs.unlink(this.paths.legacyMcpAuthFile).catch(() => undefined);
			return currentParsed.normalized;
		}

		await this.saveUnlocked(legacyParsed.normalized);
		const readBack = await readTextIfPresent(this.paths.mcpAuthFile);
		if (
			readBack === null ||
			!canonicalJsonEqual(
				parseMcpAuthDocument(readBack).normalized,
				legacyParsed.normalized,
			)
		) {
			throw new Error("mcp-auth migration read-back verification failed");
		}
		await this.recordDroppedLegacyServers(legacyParsed.droppedLegacyServers);
		await fs.unlink(this.paths.legacyMcpAuthFile);
		return legacyParsed.normalized;
	}

	private async saveUnlocked(auth: McpAuthFile): Promise<void> {
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await writeFileAtomic(this.paths.mcpAuthFile, data, { mode: 0o600 });
	}

	/**
	 * Reload, mutate, and atomically save under the interprocess auth lock.
	 * Skips writing if the serialized document did not change.
	 */
	update<T>(mutate: (auth: McpAuthFile) => T | Promise<T>): Promise<T> {
		return withAuthStoreLock(
			this.lockPath(),
			async () => {
				const auth = await this.loadUnlocked();
				const before = JSON.stringify(auth);
				const result = await mutate(auth);
				if (JSON.stringify(auth) !== before) {
					await this.saveUnlocked(auth);
				}
				return result;
			},
			this.lockOptions,
		);
	}

	async save(auth: McpAuthFile): Promise<void> {
		await withAuthStoreLock(
			this.lockPath(),
			() => this.saveUnlocked(auth),
			this.lockOptions,
		);
	}
}
