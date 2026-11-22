import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	CredentialConflictError,
	coordinateCredentialBackend,
	ensureCredentialsDirectory,
	ensureStorageDirs,
	inspectCredentialStorageStatus,
	type KeychainClient,
	KeychainError,
	type KeychainProbeResult,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
	mcpAuthStoreAdapter,
	providerAuthStoreAdapter,
	readAuthStorageState,
	resolveConfiguredAuthStorageMode,
	resolveCredentialConflict,
	resolveStoragePaths,
	writeAuthStorageState,
} from "../src";
import { MAX_KEYCHAIN_PAYLOAD_BYTES } from "../src/macos-keychain";

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
		const paths = resolveStoragePaths();
		await ensureStorageDirs(paths);
		await ensureCredentialsDirectory(paths.credentialsDir);
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

	test("auto mode reports the Keychain recovery guidance after migration or while targeting Keychain", async () => {
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
		keychain.probeResult = {
			available: false,
			reason: "keychain_unavailable",
			message: "Keychain timed out. Run `codelia auth authorize-keychain`.",
		};
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
		).rejects.toMatchObject({
			code: "keychain_unavailable",
			message: expect.stringContaining("codelia auth authorize-keychain"),
		});
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

	test("status leaves migration pending and distinguishes denied items from a locked Keychain", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const inspect = () =>
			inspectCredentialStorageStatus({
				paths,
				storageMode: "auto",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
				onReadableAuth: () => {
					throw new Error(
						"unreadable or migrating credentials must not be reported as saved",
					);
				},
			});
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "migrating",
			active_backend: "file",
			target_backend: "keyring",
			stores: { auth: "pending", mcp_auth: "pending" },
		});
		const before = await fs.readFile(paths.authStateFile, "utf8");
		expect(await inspect()).toMatchObject({
			active: "file",
			state: "migrating",
		});
		expect(await fs.readFile(paths.authStateFile, "utf8")).toBe(before);

		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});
		keychain.get = async () => {
			throw new KeychainError("keychain_access_denied", "fixture");
		};
		expect(await inspect()).toMatchObject({
			active: "keyring",
			keychainIssue: "keychain_access_denied",
		});
		keychain.probeResult = {
			available: false,
			reason: "keychain_locked",
			message: "locked fixture",
		};
		expect(await inspect()).toMatchObject({
			active: "keyring",
			keychainIssue: "keychain_locked",
		});
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

	test("empty Keychain -> file switch commits steady/file so subsequent file startups do not probe Keychain", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
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
		expect(await readAuthStorageState(paths.authStateFile)).toEqual({
			version: 1,
			status: "steady",
			active_backend: "file",
		});

		// Now lock Keychain: subsequent file startup succeeds without touching Keychain.
		keychain.probeResult = {
			available: false,
			reason: "keychain_locked",
			message: "locked",
		};
		const second = await coordinateCredentialBackend({
			paths,
			storageMode: "file",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(second.active).toBe("file");
	});

	test("interrupted reverse migration cleanup resumes Keychain deletion and prevents logout resurrection", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const account = keychainAccountForConfigDir(paths.configDir);
		const authDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-resurrect-guard" } },
				},
			},
		};
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify(authDoc),
		);
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});

		// Simulate crash during Keychain deletion on reverse migration.
		let failDelete = true;
		const origDelete = keychain.delete.bind(keychain);
		keychain.delete = async (service, acc) => {
			if (failDelete) throw new KeychainError("keychain_error", "crash");
			return origDelete(service, acc);
		};

		await expect(
			coordinateCredentialBackend({
				paths,
				storageMode: "file",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
			}),
		).rejects.toBeInstanceOf(KeychainError);

		// State must still be migrating with cleanup_pending targeting keyring cleanup.
		const midState = await readAuthStorageState(paths.authStateFile);
		expect(midState?.status).toBe("migrating");
		if (midState?.status === "migrating") {
			expect(midState.cleanup_pending).toEqual({
				source_backend: "keyring",
				auth: true,
				mcp_auth: false,
			});
		}

		// Next file-mode startup resumes and completes Keychain deletion.
		failDelete = false;
		const resumed = await coordinateCredentialBackend({
			paths,
			storageMode: "file",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(resumed).toEqual({
			configured: "file",
			active: "file",
			state: "steady",
		});
		expect(
			await keychain.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account),
		).toBeNull();
		expect(await readAuthStorageState(paths.authStateFile)).toEqual({
			version: 1,
			status: "steady",
			active_backend: "file",
		});
	});

	test("resolveCredentialConflict resolves Keychain-vs-file conflict via keep_keyring, keep_file, and clear_all", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const account = keychainAccountForConfigDir(paths.configDir);
		const kcDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-from-kc" } },
				},
			},
		};
		const fileDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-from-file" } },
				},
			},
		};
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify(kcDoc),
		);
		await fs.writeFile(paths.authFile, JSON.stringify(fileDoc), {
			mode: 0o600,
		});

		const resolved = await resolveCredentialConflict({
			paths,
			storageMode: "keyring",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
			strategy: "keep_keyring",
			stores: ["auth"],
		});
		expect(resolved).toEqual({ active: "keyring", resolvedStores: ["auth"] });
		await expect(fs.access(paths.authFile)).rejects.toThrow();
		expect(
			JSON.parse(
				(await keychain.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account)) ?? "null",
			),
		).toEqual(kcDoc);
	});

	test("resolveCredentialConflict keep_keyring refuses to delete file credentials when Keychain entry is missing", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const fileDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-only-in-file" } },
				},
			},
		};
		await fs.writeFile(paths.authFile, JSON.stringify(fileDoc), {
			mode: 0o600,
		});

		await expect(
			resolveCredentialConflict({
				paths,
				storageMode: "keyring",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
				strategy: "keep_keyring",
				stores: ["auth"],
			}),
		).rejects.toThrow(/Keychain has no saved credentials/i);

		expect(JSON.parse(await fs.readFile(paths.authFile, "utf8"))).toEqual(
			fileDoc,
		);

		// Even if Keychain contains an empty v2 document, keep_keyring must not delete the file.
		const account = keychainAccountForConfigDir(paths.configDir);
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify({ version: 2, providers: {} }),
		);
		await expect(
			resolveCredentialConflict({
				paths,
				storageMode: "keyring",
				keychain,
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
				strategy: "keep_keyring",
				stores: ["auth"],
			}),
		).rejects.toThrow(/Keychain has no saved credentials/i);
		expect(JSON.parse(await fs.readFile(paths.authFile, "utf8"))).toEqual(
			fileDoc,
		);
	});

	test("interrupted legacy-to-credentials cleanup when active_backend is keyring never deletes Keychain entries", async () => {
		const paths = resolveStoragePaths();
		const keychain = new MemoryKeychain();
		const account = keychainAccountForConfigDir(paths.configDir);
		const kcDoc = {
			version: 2,
			providers: {
				openai: {
					chat_method: "api_key",
					credentials: { api_key: { api_key: "sk-active-keychain" } },
				},
			},
		};
		await keychain.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			account,
			JSON.stringify(kcDoc),
		);
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "sk-active-keychain" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(paths.authFile, JSON.stringify(kcDoc), {
			mode: 0o600,
		});
		// Simulate crash right after migrateLegacyToCredentials recorded cleanup_pending
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "migrating",
			active_backend: "keyring",
			target_backend: "keyring",
			stores: { auth: "verified", mcp_auth: "verified" },
			cleanup_pending: {
				source_backend: "legacy_file",
				auth: true,
				mcp_auth: false,
			},
		});

		const res = await coordinateCredentialBackend({
			paths,
			storageMode: "auto",
			keychain,
			authAdapter: providerAuthStoreAdapter,
			mcpAdapter: mcpAuthStoreAdapter,
		});
		expect(res.active).toBe("keyring");
		await expect(fs.access(paths.legacyAuthFile)).rejects.toThrow();
		await expect(fs.access(paths.authFile)).rejects.toThrow();
		expect(
			JSON.parse(
				(await keychain.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account)) ?? "null",
			),
		).toEqual(kcDoc);
	});

	test("MacOsKeychainClient chunks >18 KiB payloads below the 4096-byte security -i line limit and reads legacy raw JSON", async () => {
		const fakeBin = path.join(root, "fake-security");
		const storeFile = path.join(root, "fake-keychain.json");
		await fs.writeFile(
			fakeBin,
			`#!${process.execPath}
const fs = require("node:fs");
if (process.cwd() !== "/") process.exit(2);
const storeFile = ${JSON.stringify(storeFile)};
const load = () => fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : {};
const save = (db) => fs.writeFileSync(storeFile, JSON.stringify(db));
const args = process.argv.slice(2);
if (args[0] === "show-keychain-info") {
  process.exit(0);
}
if (args[0] === "find-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) {
    process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n");
    process.exit(44);
  }
  process.stdout.write(db[key] + "\\n");
  process.exit(0);
}
if (args[0] === "delete-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) {
    process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\\n");
    process.exit(44);
  }
  delete db[key];
  save(db);
  process.exit(0);
}
if (args[0] === "-i") {
  const input = fs.readFileSync(0, "utf8");
  const db = load();
  for (const line of input.split("\\n")) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf8") >= 4096) {
      process.stderr.write("line overflow >= 4096\\n");
      process.exit(1);
    }
    const parts = line.trim().split(/\\s+/);
    if (parts[0] === "add-generic-password") {
      const acct = parts[parts.indexOf("-a") + 1];
      const svc = parts[parts.indexOf("-s") + 1];
      const val = parts[parts.indexOf("-w") + 1];
      db[svc + "::" + acct] = val;
    }
  }
  save(db);
  process.exit(0);
}
process.exit(1);
`,
			{ mode: 0o755 },
		);

		const client = new MacOsKeychainClient({ securityPath: fakeBin });
		expect(await client.probe()).toEqual({ available: true });

		// 1. Multi-chunk (> 20 KiB UTF-8) roundtrip + shrink cleanup
		const largePayload = JSON.stringify({
			version: 2,
			note: "あ".repeat(7000),
		});
		await client.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			"codelia-test",
			largePayload,
		);
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test"),
		).toBe(largePayload);
		expect(client.getSync(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test")).toBe(
			largePayload,
		);
		const dbAfterWrite = JSON.parse(await fs.readFile(storeFile, "utf8"));
		const rootKey = `${CODELIA_AUTH_KEYCHAIN_SERVICE}::codelia-test`;
		const pointer: string = dbAfterWrite[rootKey];
		expect(pointer).toMatch(/^cb2:a:12\.[a-f0-9]{64}$/);
		// Released readers split on colons and parse the count with parseInt.
		const oldFields = pointer.split(":");
		expect(oldFields).toHaveLength(3);
		expect(Number.parseInt(oldFields[2], 10)).toBe(12);

		// Shrink to single chunk -> surplus #1..N chunks must be deleted
		const smallPayload = JSON.stringify({ version: 2, providers: {} });
		await client.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			"codelia-test",
			smallPayload,
		);
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test"),
		).toBe(smallPayload);
		const dbAfterShrink = JSON.parse(await fs.readFile(storeFile, "utf8"));
		expect(Object.keys(dbAfterShrink)).toEqual([
			`${CODELIA_AUTH_KEYCHAIN_SERVICE}::codelia-test`,
		]);

		// 2. Partial mid-batch security -i failure (exiting 0!) preserves existing credentials intact
		const failMarker = path.join(root, "fail-second-chunk");
		await fs.writeFile(
			fakeBin,
			`#!${process.execPath}
const fs = require("node:fs");
const storeFile = ${JSON.stringify(storeFile)};
const failMarker = ${JSON.stringify(failMarker)};
const load = () => fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : {};
const save = (db) => fs.writeFileSync(storeFile, JSON.stringify(db));
const args = process.argv.slice(2);
if (args[0] === "show-keychain-info") process.exit(0);
if (args[0] === "find-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) {
    process.stderr.write("The specified item could not be found in the keychain.\\n");
    process.exit(44);
  }
  process.stdout.write(db[key] + "\\n");
  process.exit(0);
}
if (args[0] === "delete-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) process.exit(44);
  delete db[key];
  save(db);
  process.exit(0);
}
if (args[0] === "-i") {
  const input = fs.readFileSync(0, "utf8");
  const db = load();
  const failChunk = fs.existsSync(failMarker);
  let lineNo = 0;
  for (const line of input.split("\\n")) {
    if (!line.trim()) continue;
    lineNo += 1;
    // Simulate Apple security -i continuing after a failed subcommand and exiting 0
    if (failChunk && lineNo === 2) continue;
    const parts = line.trim().split(/\\s+/);
    if (parts[0] === "add-generic-password") {
      const acct = parts[parts.indexOf("-a") + 1];
      const svc = parts[parts.indexOf("-s") + 1];
      const val = parts[parts.indexOf("-w") + 1];
      db[svc + "::" + acct] = val;
    }
  }
  save(db);
  process.exit(0);
}
process.exit(1);
`,
			{ mode: 0o755 },
		);
		await client.set(
			CODELIA_AUTH_KEYCHAIN_SERVICE,
			"codelia-test",
			largePayload,
		);
		await fs.writeFile(failMarker, "1");
		const nextLarge = JSON.stringify({ version: 2, note: "い".repeat(7000) });
		await expect(
			client.set(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test", nextLarge),
		).rejects.toThrow(/failed verification/i);
		// Previous payload remains completely intact and staged chunks were rolled back
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test"),
		).toBe(largePayload);
		await fs.rm(failMarker, { force: true });

		// Simulate hard crash (SIGKILL) leaving orphan chunks in the inactive B slot
		const dbWithOrphans = JSON.parse(await fs.readFile(storeFile, "utf8"));
		dbWithOrphans[`${CODELIA_AUTH_KEYCHAIN_SERVICE}#g:b:0::codelia-test`] =
			"cb1:2:b3JwaGFuMA==";
		dbWithOrphans[`${CODELIA_AUTH_KEYCHAIN_SERVICE}#g:b:1::codelia-test`] =
			"cb1:2:b3JwaGFuMQ==";
		await fs.writeFile(storeFile, JSON.stringify(dbWithOrphans));
		// Logout (delete) must sweep both active and orphaned A/B slots completely
		expect(
			await client.delete(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-test"),
		).toBe(true);
		const dbAfterDelete = JSON.parse(await fs.readFile(storeFile, "utf8"));
		expect(Object.keys(dbAfterDelete)).toEqual([]);

		// 3. Legacy raw UTF-8 JSON compatibility
		await fs.writeFile(
			storeFile,
			JSON.stringify({
				[`${CODELIA_AUTH_KEYCHAIN_SERVICE}::codelia-legacy`]:
					'{"version":2,"providers":{}}',
			}),
		);
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-legacy"),
		).toBe('{"version":2,"providers":{}}');
	}, 15_000);

	test("MacOsKeychainClient aborts writes on root read error, enforces max payload size, and sweeps gapped slots strictly on delete", async () => {
		const fakeBin = path.join(root, "fake-security-strict");
		const storeFile = path.join(root, "fake-keychain-strict.json");
		const failRootFindMarker = path.join(root, "fail-root-find");
		const failDeleteServiceFile = path.join(root, "fail-delete-service");
		await fs.writeFile(
			fakeBin,
			`#!${process.execPath}
const fs = require("node:fs");
const storeFile = ${JSON.stringify(storeFile)};
const failRootFindMarker = ${JSON.stringify(failRootFindMarker)};
const failDeleteServiceFile = ${JSON.stringify(failDeleteServiceFile)};
const load = () => fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, "utf8")) : {};
const save = (db) => fs.writeFileSync(storeFile, JSON.stringify(db));
const args = process.argv.slice(2);
if (args[0] === "show-keychain-info") process.exit(0);
if (args[0] === "find-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  if (svc === ${JSON.stringify(CODELIA_AUTH_KEYCHAIN_SERVICE)} && fs.existsSync(failRootFindMarker)) {
    process.stderr.write("transient read error\\n");
    process.exit(1);
  }
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) {
    process.stderr.write("The specified item could not be found in the keychain.\\n");
    process.exit(44);
  }
  process.stdout.write(db[key] + "\\n");
  process.exit(0);
}
if (args[0] === "delete-generic-password") {
  const acct = args[args.indexOf("-a") + 1];
  const svc = args[args.indexOf("-s") + 1];
  if (fs.existsSync(failDeleteServiceFile) && fs.readFileSync(failDeleteServiceFile, "utf8").trim() === svc) {
    process.stderr.write("delete failed\\n");
    process.exit(1);
  }
  const db = load();
  const key = svc + "::" + acct;
  if (!(key in db)) process.exit(44);
  delete db[key];
  save(db);
  process.exit(0);
}
if (args[0] === "-i") {
  const input = fs.readFileSync(0, "utf8");
  const db = load();
  for (const line of input.split("\\n")) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\\s+/);
    if (parts[0] === "add-generic-password") {
      const acct = parts[parts.indexOf("-a") + 1];
      const svc = parts[parts.indexOf("-s") + 1];
      const val = parts[parts.indexOf("-w") + 1];
      db[svc + "::" + acct] = val;
    }
  }
  save(db);
  process.exit(0);
}
process.exit(1);
`,
			{ mode: 0o755 },
		);

		const client = new MacOsKeychainClient({ securityPath: fakeBin });
		const original = JSON.stringify({ version: 2, data: "a".repeat(5_000) });
		await client.set(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict", original);

		// 1. Oversized payload (> MAX_KEYCHAIN_PAYLOAD_BYTES) is rejected before writing; existing value stays intact
		const oversized = JSON.stringify({
			version: 2,
			data: "x".repeat(MAX_KEYCHAIN_PAYLOAD_BYTES),
		});
		await expect(
			client.set(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict", oversized),
		).rejects.toMatchObject({
			code: "keychain_error",
			message: expect.stringContaining("exceeds maximum size"),
		});
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict"),
		).toBe(original);

		// 2. Root read failure before set aborts without touching active slot A
		await fs.writeFile(failRootFindMarker, "1");
		await expect(
			client.set(
				CODELIA_AUTH_KEYCHAIN_SERVICE,
				"codelia-strict",
				JSON.stringify({ version: 2, data: "b".repeat(5_000) }),
			),
		).rejects.toMatchObject({ code: "keychain_error" });
		await fs.rm(failRootFindMarker, { force: true });
		expect(
			await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict"),
		).toBe(original);

		// 3. Logout propagates delete errors and sweeps gapped slots through MAX_CHUNKS-1
		const gappedChunk2 = `${CODELIA_AUTH_KEYCHAIN_SERVICE}#g:b:2`;
		const gappedChunkEnd = `${CODELIA_AUTH_KEYCHAIN_SERVICE}#g:b:63`;
		const dbWithGap = JSON.parse(await fs.readFile(storeFile, "utf8"));
		dbWithGap[`${gappedChunk2}::codelia-strict`] = "cb1:3:c2VjcmV0Mg==";
		dbWithGap[`${gappedChunkEnd}::codelia-strict`] = "cb1:64:c2VjcmV0NjM=";
		await fs.writeFile(storeFile, JSON.stringify(dbWithGap));

		await fs.writeFile(failDeleteServiceFile, gappedChunk2);
		await expect(
			client.delete(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict"),
		).rejects.toMatchObject({ code: "keychain_error" });

		await fs.rm(failDeleteServiceFile, { force: true });
		expect(
			await client.delete(CODELIA_AUTH_KEYCHAIN_SERVICE, "codelia-strict"),
		).toBe(true);
		const dbAfterStrictDelete = JSON.parse(
			await fs.readFile(storeFile, "utf8"),
		);
		expect(Object.keys(dbAfterStrictDelete)).toEqual([]);
	}, 15_000);
});
