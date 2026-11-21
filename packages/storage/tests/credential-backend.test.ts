import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	CredentialConflictError,
	coordinateCredentialBackend,
	ensureStorageDirs,
	inspectCredentialStorageStatus,
	type KeychainClient,
	KeychainError,
	type KeychainProbeResult,
	keychainAccountForConfigDir,
	mcpAuthStoreAdapter,
	providerAuthStoreAdapter,
	readAuthStorageState,
	resolveConfiguredAuthStorageMode,
	resolveStoragePaths,
	writeAuthStorageState,
} from "../src";

class MemoryKeychain implements KeychainClient {
	readonly items = new Map<string, string>();
	probeResult: KeychainProbeResult = { available: true };

	private key(service: string, account: string) {
		return `${service}::${account}`;
	}

	async probe(): Promise<KeychainProbeResult> {
		return this.probeResult;
	}

	async get(service: string, account: string): Promise<string | null> {
		if (!this.probeResult.available) {
			throw new KeychainError(
				this.probeResult.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				this.probeResult.message,
			);
		}
		return this.items.get(this.key(service, account)) ?? null;
	}

	getSync(service: string, account: string): string | null {
		if (!this.probeResult.available) {
			throw new KeychainError(
				this.probeResult.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				this.probeResult.message,
			);
		}
		return this.items.get(this.key(service, account)) ?? null;
	}

	async set(service: string, account: string, value: string): Promise<void> {
		if (!this.probeResult.available) {
			throw new KeychainError(
				this.probeResult.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				this.probeResult.message,
			);
		}
		this.items.set(this.key(service, account), value);
	}

	async delete(service: string, account: string): Promise<boolean> {
		if (!this.probeResult.available) {
			throw new KeychainError(
				this.probeResult.reason === "keychain_locked"
					? "keychain_locked"
					: "keychain_unavailable",
				this.probeResult.message,
			);
		}
		return this.items.delete(this.key(service, account));
	}
}

describe("credential backend coordination, split-brain guard, and bidirectional migration", () => {
	let root = "";
	const env = new Map<string, string | undefined>();

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-cred-backend-"));
		for (const [key, value] of Object.entries({
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			CODELIA_AUTH_STORAGE: undefined,
			CODELIA_CONFIG_PATH: undefined,
		})) {
			env.set(key, process.env[key]);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await ensureStorageDirs(resolveStoragePaths());
	});

	afterEach(async () => {
		for (const [key, value] of env) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		env.clear();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("auto mode migrates legacy v1 auth + mcp-auth to Keychain, verifies, commits steady, and deletes plaintext", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: { method: "api_key", api_key: "sk-ant-mig" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.legacyMcpAuthFile,
			JSON.stringify({
				version: 1,
				servers: { legacy_srv: { access_token: "old-unbound" } },
			}),
			{ mode: 0o600 },
		);

		const res = await coordinateCredentialBackend({
			paths,
			storageMode: "auto",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});

		expect(res).toEqual({
			configured: "auto",
			active: "keyring",
			state: "steady",
		});
		await expect(fs.access(paths.legacyAuthFile)).rejects.toThrow();
		await expect(fs.access(paths.authFile)).rejects.toThrow();
		await expect(fs.access(paths.legacyMcpAuthFile)).rejects.toThrow();
		await expect(fs.access(paths.mcpAuthFile)).rejects.toThrow();

		const account = keychainAccountForConfigDir(paths.configDir);
		const storedAuth = JSON.parse(
			(await keychain.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account)) ?? "null",
		);
		expect(storedAuth).toEqual({
			version: 2,
			providers: {
				anthropic: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-ant-mig" } },
				},
			},
		});
		const state = await readAuthStorageState(paths.authStateFile);
		expect(state).toEqual({
			version: 1,
			status: "steady",
			active_backend: "keyring",
			mcp_reauth_required: ["legacy_srv"],
		});
	});

	test("auto mode fails closed when Keychain is locked after migration or during an interrupted migration", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		keychain.probeResult = {
			available: false,
			reason: "keychain_locked",
			message: "Keychain is locked",
		};

		// Case 1: active_backend === "keyring"
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});
		await expect(
			coordinateCredentialBackend({
				paths,
				storageMode: "auto",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
			}),
		).rejects.toBeInstanceOf(KeychainError);

		// Case 2: status === "migrating" targeting "keyring"
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "migrating",
			active_backend: "file",
			target_backend: "keyring",
			stores: { auth: "verified", mcp_auth: "pending" },
		});
		await expect(
			coordinateCredentialBackend({
				paths,
				storageMode: "auto",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
			}),
		).rejects.toBeInstanceOf(KeychainError);
	});

	test("unmigrated auto mode falls back to file with fallbackReason when Keychain is unavailable", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		keychain.probeResult = {
			available: false,
			reason: "unsupported_platform",
			message: "Linux host",
		};

		const res = await coordinateCredentialBackend({
			paths,
			storageMode: "auto",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(res).toEqual({
			configured: "auto",
			active: "file",
			state: "steady",
			fallbackReason: "unsupported_platform",
		});
	});

	test("reverse migration (keyring -> file) exports to credentials/ and removes Keychain items", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const account = keychainAccountForConfigDir(paths.configDir);
		const authDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-reverse" } },
				},
			},
		};
		const mcpDoc = {
			version: 2,
			servers: {
				docs: {
					binding: { resource_uri: "https://docs.example.test/mcp" },
					tokens: { access_token: "mcp-reverse-token" },
				},
			},
		};
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify(authDoc),
		);
		await keychain.set(
			CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify(mcpDoc),
		);
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});

		const res = await coordinateCredentialBackend({
			paths,
			storageMode: "file",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(res).toEqual({
			configured: "file",
			active: "file",
			state: "steady",
		});
		expect(JSON.parse(await fs.readFile(paths.authFile, "utf8"))).toEqual(
			authDoc,
		);
		expect(JSON.parse(await fs.readFile(paths.mcpAuthFile, "utf8"))).toEqual(
			mcpDoc,
		);
		expect(
			await keychain.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account),
		).toBeNull();
		expect(
			await keychain.get(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, account),
		).toBeNull();
		expect(await readAuthStorageState(paths.authStateFile)).toEqual({
			version: 1,
			status: "steady",
			active_backend: "file",
		});
	});

	test("dual-store conflict between Keychain and file fails closed and surfaces in inspectCredentialStorageStatus", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const account = keychainAccountForConfigDir(paths.configDir);
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-kc" } },
					},
				},
			}),
		);
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-file" } },
					},
				},
			}),
			{ mode: 0o600 },
		);

		await expect(
			coordinateCredentialBackend({
				paths,
				storageMode: "keyring",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
			}),
		).rejects.toBeInstanceOf(CredentialConflictError);

		const status = await inspectCredentialStorageStatus({
			paths,
			storageMode: "keyring",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(status.state).toBe("conflict");
		expect(status.conflictStores).toEqual(["auth"]);
	});

	test("resolveConfiguredAuthStorageMode reads global config and env override only", async () => {
		const paths = resolveStoragePaths();
		expect(resolveConfiguredAuthStorageMode(paths)).toBe("auto");

		await fs.writeFile(
			paths.configFile,
			JSON.stringify({ version: 1, auth: { storage: "keyring" } }),
		);
		expect(resolveConfiguredAuthStorageMode(paths)).toBe("keyring");

		process.env.CODELIA_AUTH_STORAGE = "file";
		expect(resolveConfiguredAuthStorageMode(paths)).toBe("file");
	});
});
