import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { AuthLogoutParams, RpcMessage } from "@codelia/protocol";
import { AuthStore } from "../src/auth/store";
import { AuthResolver } from "../src/auth/resolver";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

let root: string;
let state: RuntimeState;
let store: AuthStore;
const env = new Map<string, string | undefined>();
const credentials = {
	openai: {
		method: "oauth" as const,
		oauth: {
			access_token: "test-access",
			refresh_token: "test-refresh",
			expires_at: 0,
		},
	},
	home: { method: "api_key" as const, api_key: "test-home" },
};
beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-logout-"));
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		CODELIA_CONFIG_PATH: path.join(root, "global.json"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	})) {
		env.set(key, process.env[key]);
		process.env[key] = value;
	}
	await writeFile(
		path.join(root, "global.json"),
		JSON.stringify({
			version: 1,
			model: { provider: "openai", name: "gpt-6-astra" },
			providers: {
				home: {
					type: "responses",
					base_url: "https://gateway.test/v1",
					models: { model: { context_window: 131072 } },
				},
			},
		}),
	);
	state = new RuntimeState();
	state.runtimeWorkingDir = root;
	state.setUiCapabilities({ supports_confirm: true });
	state.currentModelProvider = "openai";
	state.sessionId = "keep-session";
	state.sessionModelOverride = { provider: "openai", name: "gpt-6-astra" };
	state.agent = new Agent({
		tools: [],
		llm: {
			provider: "openai",
			model: "gpt-6-astra",
			async ainvoke() {
				throw new Error("Must not generate");
			},
		},
	});
	store = new AuthStore();
	await store.save({ version: 1, providers: credentials });
});
afterEach(async () => {
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	env.clear();
	await rm(root, { recursive: true, force: true });
});

async function logout(
	params?: AuthLogoutParams,
	confirm = true,
	beforeConfirm?: () => Promise<void>,
) {
	const messages: RpcMessage[] = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const message = JSON.parse(String(chunk)) as RpcMessage;
		messages.push(message);
		if ("method" in message && message.method === "ui.confirm.request") {
			queueMicrotask(async () => {
				try {
					await beforeConfirm?.();
				} finally {
					state.resolveUiResponse({
						jsonrpc: "2.0",
						id: "id" in message ? String(message.id) : "",
						result: { ok: confirm },
					});
				}
			});
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		const handlers = createRuntimeHandlers({
			state,
			log: () => {},
			getAgent: async () => {
				if (!state.agent)
					throw new Error("Must not create an agent for logout");
				return state.agent;
			},
		});
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "logout",
			method: "auth.logout",
			params,
		});
		const deadline = Date.now() + 2000;
		while (
			!messages.some(
				(message) =>
					"id" in message && message.id === "logout" && !("method" in message),
			)
		) {
			if (Date.now() > deadline) throw new Error("Logout RPC did not settle");
			await Bun.sleep(1);
		}
	} finally {
		process.stdout.write = write;
	}
	return messages as Array<{
		id?: string;
		method?: string;
		params?: { message?: string };
		result?: Record<string, unknown>;
		error?: unknown;
	}>;
}

test("named logout removes home only and preserves the OpenAI agent, OAuth and session", async () => {
	const agent = state.agent;
	const messages = await logout({ provider: "home" });
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
	});
	expect(state.agent).toBe(agent);
	expect(state.sessionId).toBe("keep-session");
	expect(state.sessionModelOverride?.provider).toBe("openai");
	expect(messages.at(-1)?.result).toEqual({
		ok: true,
		auth_cleared: true,
		session_cleared: false,
		provider: "home",
	});
	expect(messages[0].params?.message).toContain("home only");
});

test("logging out the active provider resets its agent/session and keeps other keys", async () => {
	state.currentModelProvider = "home";
	const messages = await logout({ provider: "home" });
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
	});
	expect(state.agent).toBeNull();
	expect(state.sessionId).toBeNull();
	expect(state.sessionModelOverride).toBeNull();
	expect(messages.at(-1)?.result?.session_cleared).toBe(true);
});

test("unnamed logout retains all-provider behavior and clear_session=false preserves the session", async () => {
	const messages = await logout({ clear_session: false });
	expect((await store.load()).providers).toEqual({});
	expect(state.agent).toBeNull();
	expect(state.sessionId).toBe("keep-session");
	expect(messages.at(-1)?.result).toEqual({
		ok: true,
		auth_cleared: true,
		session_cleared: false,
	});
	await store.save({ version: 1, providers: credentials });
	expect((await logout()).at(-1)?.result?.session_cleared).toBe(true);
	expect((await store.load()).providers).toEqual({});
	expect(state.sessionId).toBeNull();
});

test("cancelled, unknown and malformed names never clear credentials or reset sessions", async () => {
	const cancelled = await logout({ provider: "home" }, false);
	expect(cancelled.at(-1)?.result?.cancelled).toBe(true);
	for (const provider of [
		"missing",
		"",
		"home/strata-modal",
		"__proto__",
		42,
	]) {
		const messages = await logout({ provider } as AuthLogoutParams);
		expect(messages).toHaveLength(1);
		expect(messages[0].error).toBeDefined();
	}
	expect((await store.load()).providers).toEqual(credentials);
	expect(state.sessionId).toBe("keep-session");
});

test("credentials added while awaiting confirmation survive a named logout", async () => {
	await logout({ provider: "home" }, true, async () => {
		const auth = await store.load();
		auth.providers.xai = { method: "api_key", api_key: "test-new" };
		await store.save(auth);
	});
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
		xai: { method: "api_key", api_key: "test-new" },
	});
});

test("a cached resolver saving another provider does not resurrect a logged-out name", async () => {
	env.set("XAI_API_KEY", process.env.XAI_API_KEY);
	process.env.XAI_API_KEY = "test-new-xai";
	const resolver = await AuthResolver.create(state, () => {});
	await logout({ provider: "home" });
	await resolver.resolveProviderAuth("xai");
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
		xai: { method: "api_key", api_key: "test-new-xai" },
	});
});

test("configured providers with no saved key are harmless; stored names work after removal from config", async () => {
	await store.save({
		version: 1,
		providers: { openai: credentials.openai, retired: credentials.home },
	});
	expect((await logout({ provider: "home" })).at(-1)?.error).toBeUndefined();
	expect((await logout({ provider: "retired" })).at(-1)?.error).toBeUndefined();
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
	});
});

test("embedded hosts must support scoped logout explicitly and never fall back to clearAuth", async () => {
	let allCalls = 0;
	const scoped: string[] = [];
	const credentialProvider = {
		resolveProvider: async () => "openai",
		resolveProviderAuth: async () => credentials.openai,
		clearAuth: async () => {
			allCalls++;
		},
	};
	const adapters = {
		credentialProvider,
		systemPromptProvider: { loadSystemPrompt: () => "test" },
		configProvider: {
			resolveModelConfig: async () => ({ provider: "openai" }),
		},
		eventSink: { emit: () => {} },
		toolProviders: [],
	};
	state.setRuntimeEnvironment({
		environment: { preset: "embedded-no-local-tools" },
		adapters,
	});
	expect((await logout({ provider: "home" })).at(-1)?.error).toBeDefined();
	expect(allCalls).toBe(0);
	state.setRuntimeEnvironment({
		environment: { preset: "embedded-no-local-tools" },
		adapters: {
			...adapters,
			credentialProvider: {
				...credentialProvider,
				clearProviderAuth: async (provider) => {
					scoped.push(provider);
				},
			},
		},
	});
	expect((await logout({ provider: "home" })).at(-1)?.result?.provider).toBe(
		"home",
	);
	expect(scoped).toEqual(["home"]);
	expect(state.sessionId).toBe("keep-session");
	await logout();
	expect(allCalls).toBe(1);
	expect(state.sessionId).toBeNull();
	expect((await store.load()).providers).toEqual(credentials);
});
