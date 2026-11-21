import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CredentialConflictError,
	ensureCredentialsDirectory,
	ensureStorageDirs,
	resolveStoragePaths,
} from "@codelia/storage";
import { AuthResolver } from "../src/auth/resolver";
import {
	AuthStore,
	clearProviderMethod,
	getChatProviderAuth,
	getStoredProviderApiKey,
	setProviderApiKey,
	setProviderChatAuth,
} from "../src/auth/store";
import { localImageAuth } from "../src/image-generation/route";
import { RuntimeState } from "../src/runtime-state";

describe("AuthStore v2 coexistence, refresh safety, and file migration", () => {
	const originalFetch = globalThis.fetch;
	const env = new Map<string, string | undefined>();
	let root = "";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-auth-v2-"));
		for (const [key, value] of Object.entries({
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"),
		})) {
			env.set(key, process.env[key]);
			process.env[key] = value;
		}
		const paths = resolveStoragePaths();
		await ensureStorageDirs(paths);
		await ensureCredentialsDirectory(paths.credentialsDir);
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of env) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		env.clear();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("migrates legacy root v1 auth.json into credentials/ v2 and removes legacy file", async () => {
		const paths = resolveStoragePaths();
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					openai: {
						method: "oauth",
						oauth: {
							access_token: "acc-1",
							refresh_token: "ref-1",
							expires_at: 9_999_999_999_999,
							account_id: "acct-1",
						},
					},
				},
			}),
			{ mode: 0o600 },
		);

		const store = new AuthStore();
		const loaded = await store.loadV2();
		expect(loaded).toEqual({
			version: 2,
			providers: {
				openai: {
					chat_method: "oauth",
					credentials: {
						oauth: {
							access_token: "acc-1",
							refresh_token: "ref-1",
							expires_at: 9_999_999_999_999,
							account_id: "acct-1",
						},
					},
				},
			},
		});
		await expect(fs.access(paths.legacyAuthFile)).rejects.toThrow();
		const onDisk = JSON.parse(await fs.readFile(paths.authFile, "utf8"));
		expect(onDisk.version).toBe(2);
	});

	test("OAuth chat and stored API key coexist; refresh preserves API key and chat_method", async () => {
		const store = new AuthStore();
		await store.updateV2((auth) => {
			setProviderChatAuth(auth, "openai", {
				method: "oauth",
				oauth: {
					access_token: "acc-expired",
					refresh_token: "ref-old",
					expires_at: 0,
					account_id: "acct-1",
				},
			});
			setProviderApiKey(auth, "openai", { api_key: "sk-image-coexist" });
		});

		// Image API key lookup reads credentials.api_key while chat keeps OAuth
		expect(await localImageAuth.storedKey("openai")).toBe("sk-image-coexist");
		const resolver = await AuthResolver.create(new RuntimeState(), () => {});
		const chatAuth = await resolver.resolveProviderAuth("openai");
		expect(chatAuth.method).toBe("oauth");

		globalThis.fetch = Object.assign(
			async () =>
				Response.json({
					access_token: "acc-refreshed",
					refresh_token: "ref-new",
					expires_in: 3600,
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const refreshed = await resolver.getOpenAiAccessToken();
		expect(refreshed.token).toBe("acc-refreshed");

		const after = await store.loadV2();
		expect(after.providers.openai?.chat_method).toBe("oauth");
		expect(getStoredProviderApiKey(after, "openai")?.api_key).toBe(
			"sk-image-coexist",
		);
		expect(after.providers.openai?.credentials.oauth?.refresh_token).toBe(
			"ref-new",
		);
	});

	test("clearing the active chat method never silently falls back to the remaining credential", async () => {
		const store = new AuthStore();
		await store.updateV2((auth) => {
			setProviderChatAuth(auth, "openai", {
				method: "oauth",
				oauth: {
					access_token: "acc-1",
					refresh_token: "ref-1",
					expires_at: 9_999_999_999_999,
				},
			});
			setProviderApiKey(auth, "openai", { api_key: "sk-image-only" });
			clearProviderMethod(auth, "openai", "oauth");
		});
		const after = await store.loadV2();
		expect(getChatProviderAuth(after, "openai")).toBeUndefined();
		expect(getStoredProviderApiKey(after, "openai")?.api_key).toBe(
			"sk-image-only",
		);
	});

	test("detects conflict when legacy root and credentials/ auth.json differ without overwriting either", async () => {
		const paths = resolveStoragePaths();
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: { method: "api_key", api_key: "sk-legacy-key" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					anthropic: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-new-key" } },
					},
				},
			}),
			{ mode: 0o600 },
		);

		const store = new AuthStore();
		await expect(store.loadV2()).rejects.toBeInstanceOf(
			CredentialConflictError,
		);
		expect(await fs.readFile(paths.legacyAuthFile, "utf8")).toContain(
			"sk-legacy-key",
		);
		expect(await fs.readFile(paths.authFile, "utf8")).toContain("sk-new-key");
	});

	test("recovers cleanly when legacy root and credentials/ auth.json have identical normalized content", async () => {
		const paths = resolveStoragePaths();
		await fs.writeFile(
			paths.legacyAuthFile,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: { method: "api_key", api_key: "sk-same" },
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.authFile,
			JSON.stringify({
				version: 2,
				providers: {
					anthropic: {
						chat_method: "api_key",
						credentials: { api_key: { api_key: "sk-same" } },
					},
				},
			}),
			{ mode: 0o600 },
		);

		const loaded = await new AuthStore().loadV2();
		expect(getStoredProviderApiKey(loaded, "anthropic")?.api_key).toBe(
			"sk-same",
		);
		await expect(fs.access(paths.legacyAuthFile)).rejects.toThrow();
	});

	test("rejects unknown auth.json version without overwriting the file", async () => {
		const paths = resolveStoragePaths();
		const raw = JSON.stringify({ version: 99, providers: {} });
		await fs.writeFile(paths.authFile, raw, { mode: 0o600 });
		await expect(new AuthStore().loadV2()).rejects.toThrow(
			"unsupported version",
		);
		expect(await fs.readFile(paths.authFile, "utf8")).toBe(raw);
	});
});
