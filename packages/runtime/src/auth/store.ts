import {
	closeSync,
	constants,
	promises as fs,
	fstatSync,
	openSync,
	readFileSync,
} from "node:fs";
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
			/** The built-in API base at credential acquisition, when known. */
			api_base?: string;
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

/** Per-file queue so concurrent load/merge/save sequences never drop entries. */
const authWriteQueues = new Map<string, Promise<void>>();

const parseAuthFile = (text: string): AuthFile => {
	const parsed = JSON.parse(text) as Partial<AuthFile> | null;
	if (!parsed || parsed.version !== AUTH_VERSION)
		throw new Error("auth.json has unsupported version");
	return { version: AUTH_VERSION, providers: parsed.providers ?? {} };
};

const absentAuthFile = (error: unknown): AuthFile => {
	if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
		return { version: AUTH_VERSION, providers: {} };
	throw error;
};

export class AuthStore {
	private readonly paths: StoragePaths;

	constructor(paths?: StoragePaths) {
		this.paths = paths ?? resolveStoragePaths();
	}

	async load(): Promise<AuthFile> {
		try {
			return parseAuthFile(await fs.readFile(this.paths.authFile, "utf8"));
		} catch (error) {
			return absentAuthFile(error);
		}
	}

	/** Synchronous snapshot for a one-use local approval consumed immediately before spawn. */
	loadForApproval(): AuthFile {
		let fd: number;
		try {
			fd = openSync(
				this.paths.authFile,
				constants.O_RDONLY | constants.O_NONBLOCK,
			);
		} catch (error) {
			return absentAuthFile(error);
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile() || stat.size > 1024 * 1024)
				throw new Error("auth.json cannot be read at approval time");
			return parseAuthFile(readFileSync(fd, "utf8"));
		} finally {
			closeSync(fd);
		}
	}

	private async enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const key = this.paths.authFile;
		const previous = authWriteQueues.get(key) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		authWriteQueues.set(key, settled);
		try {
			return await next;
		} finally {
			if (authWriteQueues.get(key) === settled) authWriteQueues.delete(key);
		}
	}

	/**
	 * Reload, mutate and save under a per-file queue. Use this for every
	 * credential change made outside the cached-resolver flow.
	 */
	update<T>(mutate: (auth: AuthFile) => T | Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const auth = await this.load();
			const result = await mutate(auth);
			await this.save(auth);
			return result;
		});
	}

	/** Queued removal of every provider; works even if the file is unreadable. */
	clearAll(): Promise<void> {
		return this.enqueue(() =>
			this.save({ version: AUTH_VERSION, providers: {} }),
		);
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
