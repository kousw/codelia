import { promises as fs } from "node:fs";
import type { StoragePaths } from "@codelia/core";
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

	constructor(paths?: StoragePaths) {
		this.paths = paths ?? resolveStoragePaths();
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

	async save(auth: McpAuthFile): Promise<void> {
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await fs.writeFile(this.paths.mcpAuthFile, data, { mode: 0o600 });
		try {
			await fs.chmod(this.paths.mcpAuthFile, 0o600);
		} catch {
			// ignore permission errors (e.g., Windows)
		}
	}
}
