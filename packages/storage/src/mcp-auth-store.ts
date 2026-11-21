import { promises as fs } from "node:fs";
import type { StoragePaths } from "@codelia/core";
import { writeFileAtomic } from "./atomic-file";
import {
	type AuthLockOptions,
	authLockPathFor,
	withAuthStoreLock,
} from "./auth-lock";
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

export type McpAuthFile = {
	version: 1;
	servers: Record<string, McpOAuthTokens>;
};

const MCP_AUTH_VERSION = 1 as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const pickString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;

const pickNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

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

export class McpAuthStore {
	private readonly paths: StoragePaths;
	private readonly lockOptions?: AuthLockOptions;

	constructor(paths?: StoragePaths, options?: { lock?: AuthLockOptions }) {
		this.paths = paths ?? resolveStoragePaths();
		this.lockOptions = options?.lock;
	}

	private lockPath(): string {
		return authLockPathFor(this.paths.configDir);
	}

	async load(): Promise<McpAuthFile> {
		try {
			const text = await fs.readFile(this.paths.mcpAuthFile, "utf8");
			const parsed = JSON.parse(text) as unknown;
			if (!isRecord(parsed) || parsed.version !== MCP_AUTH_VERSION) {
				throw new Error("mcp-auth.json has unsupported version");
			}
			const serversRaw = isRecord(parsed.servers) ? parsed.servers : {};
			const servers: Record<string, McpOAuthTokens> = {};
			for (const [id, entry] of Object.entries(serversRaw)) {
				const normalized = normalizeTokens(entry);
				if (normalized) {
					servers[id] = normalized;
				}
			}
			return {
				version: MCP_AUTH_VERSION,
				servers,
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code === "ENOENT") {
				return { version: MCP_AUTH_VERSION, servers: {} };
			}
			throw error;
		}
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
				const auth = await this.load();
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
