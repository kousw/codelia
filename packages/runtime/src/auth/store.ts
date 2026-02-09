import { promises as fs } from "node:fs";
import type { StoragePaths } from "@codelia/core";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";

export type OAuthTokens = {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	account_id?: string;
};

export type ProviderAuth =
	| {
			method: "api_key";
			api_key: string;
	  }
	| {
			method: "oauth";
			oauth: OAuthTokens;
	  };

export type AuthFile = {
	version: 1;
	providers: Record<string, ProviderAuth>;
};

const AUTH_VERSION = 1 as const;

export class AuthStore {
	private readonly paths: StoragePaths;

	constructor(paths?: StoragePaths) {
		this.paths = paths ?? resolveStoragePaths();
	}

	async load(): Promise<AuthFile> {
		try {
			const text = await fs.readFile(this.paths.authFile, "utf8");
			const parsed = JSON.parse(text) as Partial<AuthFile> | null;
			if (!parsed || parsed.version !== AUTH_VERSION) {
				throw new Error("auth.json has unsupported version");
			}
			return {
				version: AUTH_VERSION,
				providers: parsed.providers ?? {},
			};
		} catch (error) {
			const err = error as NodeJS.ErrnoException;
			if (err?.code === "ENOENT") {
				return { version: AUTH_VERSION, providers: {} };
			}
			throw error;
		}
	}

	async save(auth: AuthFile): Promise<void> {
		await ensureStorageDirs(this.paths);
		const data = JSON.stringify(auth, null, 2);
		await fs.writeFile(this.paths.authFile, data, { mode: 0o600 });
		try {
			await fs.chmod(this.paths.authFile, 0o600);
		} catch {
			// ignore permission errors (e.g., Windows)
		}
	}
}
