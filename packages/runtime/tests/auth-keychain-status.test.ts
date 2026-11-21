import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthStatusResult, RpcMessage } from "@codelia/protocol";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	ensureStorageDirs,
	type KeychainClient,
	KeychainError,
	keychainAccountForConfigDir,
	MacOsKeychainClient,
	resolveMacOsCredentialHelper,
	resolveStoragePaths,
	writeAuthStorageState,
} from "@codelia/storage";
import { AuthStore, setProviderChatAuth } from "../src/auth/store";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

describe("auth.status storage/warning metadata and live macOS Keychain helper", () => {
	let root = "";
	const env = new Map<string, string | undefined>();

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-auth-status-"));
		for (const [key, value] of Object.entries({
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			CODELIA_AUTH_STORAGE: "file",
		})) {
			env.set(key, process.env[key]);
			process.env[key] = value;
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

	test("auth.status surfaces storage backend and non-secret warnings even during conflict", async () => {
		const paths = resolveStoragePaths();
		const workspace = path.join(root, "workspace");
		await fs.mkdir(path.join(workspace, ".codelia"), { recursive: true });
		await fs.writeFile(
			path.join(workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						inline_srv: {
							transport: "http",
							url: "https://mcp.example.test/rpc",
							headers: { Authorization: "Bearer super-secret-inline-token" },
						},
					},
				},
			}),
		);
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "sk-legacy-secret" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-new-secret" } },
					},
				},
			}),
			{ mode: 0o600 },
		);

		const state = new RuntimeState();
		state.runtimeWorkingDir = workspace;
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => {
				throw new Error("unexpected getAgent");
			},
			log: () => {},
		});
		const pending = Promise.withResolvers<RpcMessage>();
		const write = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			for (const line of String(chunk).split("\n")) {
				if (!line.trim()) continue;
				const parsed = JSON.parse(line) as RpcMessage;
				if ("id" in parsed && parsed.id === "st-1") {
					pending.resolve(parsed);
				}
			}
			return true;
		}) as typeof process.stdout.write;
		let response: RpcMessage;
		try {
			await handlers.processMessage({
				jsonrpc: "2.0",
				id: "st-1",
				method: "auth.status",
				params: {},
			});
			response = await pending.promise;
		} finally {
			process.stdout.write = write;
		}

		expect("result" in response).toBe(true);
		const result = (response as { result: AuthStatusResult }).result;
		expect(result.storage).toEqual({
			configured: "file",
			active: "file",
			state: "conflict",
		});
		const warningCodes = (result.warnings ?? []).map((w) => w.code).sort();
		expect(warningCodes).toEqual([
			"inline_mcp_config_secrets",
			"storage_conflict",
		]);
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("super-secret-inline-token");
		expect(serialized).not.toContain("sk-legacy-secret");
		expect(serialized).not.toContain("sk-new-secret");
	});

	test("loadForApprovalV2 reads Keychain synchronously and fails closed on locked Keychain", async () => {
		const paths = resolveStoragePaths();
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});
		const lockedClient: KeychainClient = {
			probe: async () => ({
				available: false,
				reason: "keychain_locked",
				message: "locked",
			}),
			get: async () => {
				throw new KeychainError("keychain_locked", "locked");
			},
			getSync: () => {
				throw new KeychainError("keychain_locked", "locked");
			},
			set: async () => {},
			delete: async () => false,
		};
		const store = new AuthStore(paths, {
			storageMode: "auto",
			keychain: lockedClient,
		});
		expect(() => store.loadForApprovalV2()).toThrow(KeychainError);
	});

	test.skipIf(process.platform !== "darwin" || !resolveMacOsCredentialHelper())(
		"live macOS Keychain helper supports >16 KiB UTF-8 JSON roundtrip, loadForApprovalV2, and reverse migration cleanup",
		async () => {
			const paths = resolveStoragePaths();
			const account = keychainAccountForConfigDir(paths.configDir);
			const client = new MacOsKeychainClient();
			const probe = await client.probe();
			if (!probe.available) return;

			try {
				const store = new AuthStore(paths, {
					storageMode: "keyring",
					keychain: client,
				});
				const largeNote = "あ".repeat(6000); // > 18 KiB UTF-8
				await store.updateV2((auth) => {
					setProviderChatAuth(auth, "openai", {
						method: "api_key",
						api_key: `sk-live-keychain-${largeNote}`,
					});
				});

				// Plaintext authFile must not exist in keyring mode
				await expect(fs.access(paths.authFile)).rejects.toThrow();

				// Async load and sync approval snapshot both succeed
				const loaded = await store.loadV2();
				expect(loaded.providers.openai?.credentials.api_key?.api_key).toBe(
					`sk-live-keychain-${largeNote}`,
				);
				const syncSnap = store.loadForApprovalV2();
				expect(syncSnap.providers.openai?.credentials.api_key?.api_key).toBe(
					`sk-live-keychain-${largeNote}`,
				);

				// Reverse switch to file mode exports and cleans Keychain
				const fileStore = new AuthStore(paths, {
					storageMode: "file",
					keychain: client,
				});
				const exported = await fileStore.loadV2();
				expect(exported.providers.openai?.credentials.api_key?.api_key).toBe(
					`sk-live-keychain-${largeNote}`,
				);
				expect(
					await client.get(CODELIA_AUTH_KEYCHAIN_SERVICE, account),
				).toBeNull();
			} finally {
				await client
					.delete(CODELIA_AUTH_KEYCHAIN_SERVICE, account)
					.catch(() => undefined);
				await client
					.delete(CODELIA_MCP_AUTH_KEYCHAIN_SERVICE, account)
					.catch(() => undefined);
			}
		},
	);
});
