import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	AuthStatusResult,
	AuthStorageResolveConflictResult,
	RpcMessage,
} from "@codelia/protocol";
import {
	CODELIA_AUTH_KEYCHAIN_SERVICE,
	CODELIA_MCP_AUTH_KEYCHAIN_SERVICE,
	CredentialConflictError,
	ensureCredentialsDirectory,
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

	test("loadForApprovalV2 fails closed on corrupt marker, migrating state, and dual-store conflicts", async () => {
		const paths = resolveStoragePaths();
		const store = new AuthStore(paths, { storageMode: "file" });

		// 1. Corrupt storage-state.json MUST throw (never silently fall back)
		await fs.writeFile(paths.authStateFile, "{ not valid json", {
			mode: 0o600,
		});
		expect(() => store.loadForApprovalV2()).toThrow();

		// 2. Migrating / cleanup_pending state MUST throw
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "migrating",
			active_backend: "keyring",
			target_backend: "file",
			stores: { auth: "verified", mcp_auth: "verified" },
			cleanup_pending: {
				source_backend: "keyring",
				auth: true,
				mcp_auth: false,
			},
		});
		expect(() => store.loadForApprovalV2()).toThrow(/migration/i);

		// 3. Steady/file with conflicting credentials/auth.json vs legacy auth.json MUST throw
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "file",
		});
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-current" } },
					},
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "sk-legacy" },
				},
			}),
			{ mode: 0o600 },
		);
		expect(() => store.loadForApprovalV2()).toThrow(CredentialConflictError);

		// 4. Keychain-vs-file conflict in keyring mode MUST throw
		const memClient: KeychainClient = {
			probe: async () => ({ available: true }),
			get: async () =>
				JSON.stringify({
					version: 2,
					providers: {
						openai: {
							chat_method: "api_key",
							credentials: { api_key: { api_key: "sk-kc" } },
						},
					},
				}),
			getSync: () =>
				JSON.stringify({
					version: 2,
					providers: {
						openai: {
							chat_method: "api_key",
							credentials: { api_key: { api_key: "sk-kc" } },
						},
					},
				}),
			set: async () => {},
			delete: async () => false,
		};
		await fs.unlink(paths.legacyAuthFile);
		await writeAuthStorageState(paths.authStateFile, {
			version: 1,
			status: "steady",
			active_backend: "keyring",
		});
		const kcStore = new AuthStore(paths, {
			storageMode: "keyring",
			keychain: memClient,
		});
		expect(() => kcStore.loadForApprovalV2()).toThrow(CredentialConflictError);
	});

	test("AuthStore.clearAll and auth.storage.resolve_conflict RPC recover from dual-store conflict without touching MCP on logout", async () => {
		const paths = resolveStoragePaths();
		const workspace = path.join(root, "workspace-conflict");
		await fs.mkdir(workspace, { recursive: true });
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					openai: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-keep-me" } },
					},
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "sk-stale-legacy" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.mcpAuthFile,
			JSON.stringify({
				version: 2,
				servers: {
					docs: {
						binding: { resource_uri: "https://docs.example.test/mcp" },
						tokens: { access_token: "mcp-stays-intact" },
					},
				},
			}),
			{ mode: 0o600 },
		);

		// Resolve via RPC `auth.storage.resolve_conflict` with `keep_file`
		const state = new RuntimeState();
		state.runtimeWorkingDir = workspace;
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => {
				throw new Error("unexpected getAgent");
			},
			log: () => {},
		});
		const callRpc = async (id: string, method: string, params: unknown) => {
			const pending = Promise.withResolvers<RpcMessage>();
			const write = process.stdout.write;
			process.stdout.write = ((chunk: string | Uint8Array) => {
				for (const line of String(chunk).split("\n")) {
					if (!line.trim()) continue;
					const parsed = JSON.parse(line) as RpcMessage;
					if ("id" in parsed && parsed.id === id) {
						pending.resolve(parsed);
					}
				}
				return true;
			}) as typeof process.stdout.write;
			try {
				await handlers.processMessage({
					jsonrpc: "2.0",
					id,
					method,
					params,
				});
				return await pending.promise;
			} finally {
				process.stdout.write = write;
			}
		};

		const resolveResp = await callRpc("rc-1", "auth.storage.resolve_conflict", {
			strategy: "keep_file",
			stores: ["auth"],
			confirmed: true,
		});
		expect("result" in resolveResp).toBe(true);
		const resolveRes = (
			resolveResp as { result: AuthStorageResolveConflictResult }
		).result;
		expect(resolveRes).toEqual({
			ok: true,
			active: "file",
			resolved_stores: ["auth"],
		});
		const afterResolve = await new AuthStore(paths).loadV2();
		expect(afterResolve.providers.openai?.credentials.api_key?.api_key).toBe(
			"sk-keep-me",
		);

		// Re-create conflict and verify full `clearAll()` clears auth without failing or touching MCP
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: { method: "api_key", api_key: "sk-conflict-again" },
				},
			}),
			{ mode: 0o600 },
		);
		await new AuthStore(paths).clearAll();
		await expect(fs.access(paths.authFile)).rejects.toThrow();
		await expect(fs.access(paths.legacyAuthFile)).rejects.toThrow();
		expect(await fs.readFile(paths.mcpAuthFile, "utf8")).toContain(
			"mcp-stays-intact",
		);
	});

	test.skipIf(
		process.platform !== "darwin" ||
			!resolveMacOsCredentialHelper({ untrustedRoots: [] }),
	)(
		"live macOS Keychain helper supports >16 KiB UTF-8 JSON roundtrip, loadForApprovalV2, and reverse migration cleanup",
		async () => {
			const paths = resolveStoragePaths();
			const isolatedWorkspace = path.join(root, "isolated-workspace");
			await fs.mkdir(isolatedWorkspace, { recursive: true });
			const account = keychainAccountForConfigDir(paths.configDir);
			const client = new MacOsKeychainClient({
				untrustedRoots: [isolatedWorkspace],
			});
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
