import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { RpcMessage } from "@codelia/protocol";
import { resolveStoragePaths } from "@codelia/storage";
import { AuthStore } from "../src/auth/store";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

let root: string;
let state: RuntimeState;
let store: AuthStore;
let messages: RpcMessage[];
let restoreStdout: () => void;
let handlers: ReturnType<typeof createRuntimeHandlers>;
const env = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const credentials = {
	openai: {
		method: "oauth" as const,
		oauth: {
			access_token: "secret-access",
			refresh_token: "secret-refresh",
			expires_at: 1234,
		},
	},
	home: { method: "api_key" as const, api_key: "secret-home" },
};

const setEnv = (key: string, value: string | undefined): void => {
	if (!env.has(key)) env.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};

const makeAgent = (): Agent =>
	new Agent({
		tools: [],
		llm: {
			provider: "openai",
			model: "gpt-6-astra",
			async ainvoke() {
				throw new Error("Must not generate");
			},
		},
	});

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-auth-mgmt-"));
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		CODELIA_CONFIG_PATH: path.join(root, "global.json"),
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	})) {
		setEnv(key, value);
	}
	for (const key of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"OPENROUTER_API_KEY",
		"GOOGLE_API_KEY",
		"GEMINI_API_KEY",
		"DEEPSEEK_API_KEY",
		"MOONSHOT_API_KEY",
		"ZAI_API_KEY",
		"XAI_API_KEY",
		"HOME_GATEWAY_KEY",
		"CODELIA_OPENAI_OAUTH_PORT",
	]) {
		setEnv(key, undefined);
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
					api_key_env: "HOME_GATEWAY_KEY",
					models: { model: { context_window: 131072 } },
				},
			},
		}),
	);
	state = new RuntimeState();
	state.runtimeWorkingDir = root;
	state.currentModelProvider = "openai";
	state.agent = makeAgent();
	store = new AuthStore();
	await store.save({ version: 1, providers: structuredClone(credentials) });
	messages = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		messages.push(JSON.parse(String(chunk)) as RpcMessage);
		return true;
	}) as typeof process.stdout.write;
	restoreStdout = () => {
		process.stdout.write = write;
	};
	handlers = createRuntimeHandlers({
		state,
		log: () => {},
		getAgent: async () => {
			throw new Error("Must not create an agent for auth management");
		},
	});
});

afterEach(async () => {
	restoreStdout();
	globalThis.fetch = originalFetch;
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	env.clear();
	await rm(root, { recursive: true, force: true });
});

type Response = {
	id?: string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

let requestSeq = 0;
const request = async (method: string, params?: unknown): Promise<Response> => {
	requestSeq += 1;
	const id = `req-${requestSeq}`;
	handlers.processMessage({ jsonrpc: "2.0", id, method, params });
	const deadline = Date.now() + 2000;
	for (;;) {
		const found = (messages as Response[]).find(
			(message) => message.id === id && !message.method,
		);
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`${method} did not settle`);
		await Bun.sleep(1);
	}
};

const waitForNotification = async (
	method: string,
	predicate: (params: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> => {
	const deadline = Date.now() + 2000;
	for (;;) {
		const found = (messages as Response[]).find(
			(message) =>
				message.method === method &&
				message.id === undefined &&
				predicate(message.params ?? {}),
		);
		if (found?.params) return found.params;
		if (Date.now() > deadline) throw new Error(`${method} not received`);
		await Bun.sleep(1);
	}
};

const mockTokenExchange = (): string[] => {
	const bodies: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/oauth/token")) {
			bodies.push(String(init?.body ?? ""));
			return Response.json({
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
			});
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;
	return bodies;
};

test("initialize advertises auth management for runtime-owned credentials", async () => {
	const response = await request("initialize", {
		protocol_version: "0",
		client: { name: "gui", version: "0" },
		ui_capabilities: { supports_auth_management: true },
	});
	const capabilities = response.result?.server_capabilities as Record<
		string,
		unknown
	>;
	expect(capabilities.supports_auth_management).toBe(true);
});

test("auth.status summarizes providers without returning credential material", async () => {
	setEnv("ANTHROPIC_API_KEY", "secret-env");
	const response = await request("auth.status");
	const serialized = JSON.stringify(response);
	for (const secret of [
		"secret-access",
		"secret-refresh",
		"secret-home",
		"secret-env",
	]) {
		expect(serialized).not.toContain(secret);
	}
	const providers = response.result?.providers as Array<
		Record<string, unknown>
	>;
	const byName = new Map(providers.map((entry) => [entry.provider, entry]));
	expect(byName.get("openai")).toEqual({
		provider: "openai",
		kind: "builtin",
		methods: ["oauth", "device_code", "api_key"],
		saved: { method: "oauth", expires_at: 1234 },
		env: { name: "OPENAI_API_KEY", present: false },
		active: true,
	});
	expect(byName.get("anthropic")).toMatchObject({
		methods: ["api_key"],
		saved: null,
		env: { name: "ANTHROPIC_API_KEY", present: true },
		active: false,
	});
	expect(byName.get("home")).toMatchObject({
		kind: "config",
		saved: { method: "api_key" },
		env: { name: "HOME_GATEWAY_KEY", present: false },
	});

	const scoped = await request("auth.status", { provider: "home" });
	expect(scoped.result?.providers).toHaveLength(1);
	expect(
		(await request("auth.status", { provider: "missing" })).error?.code,
	).toBe(-32602);
});

test("auth.status reads a legacy store without initializing or migrating it", async () => {
	setEnv("XDG_CONFIG_HOME", path.join(root, "legacy-config"));
	const paths = resolveStoragePaths();
	await mkdir(paths.configDir, { recursive: true });
	const legacy = JSON.stringify({ version: 1, providers: credentials });
	await writeFile(paths.legacyAuthFile, legacy, { mode: 0o600 });
	const before = await readdir(paths.configDir);
	const response = await request("auth.status", { provider: "openai" });
	expect(response.result?.providers).toMatchObject([
		{ saved: { method: "oauth", expires_at: 1234 } },
	]);
	expect(JSON.stringify(response)).not.toContain("secret-access");
	expect(await readdir(paths.configDir)).toEqual(before);
	expect(await readFile(paths.legacyAuthFile, "utf8")).toBe(legacy);
});

test("auth.status preserves provider metadata and reports an unreadable MCP slot", async () => {
	const paths = resolveStoragePaths();
	await writeFile(paths.mcpAuthFile, "{malformed", { mode: 0o600 });
	const response = await request("auth.status", { provider: "openai" });
	expect(response.result?.providers).toMatchObject([
		{ saved: { method: "oauth", expires_at: 1234 } },
	]);
	expect(response.result?.warnings).toMatchObject([
		{ code: "storage_unreadable", targets: ["mcp_auth"] },
	]);
	expect(await readFile(paths.mcpAuthFile, "utf8")).toBe("{malformed");
});

test("auth.login api_key saves only that provider and invalidates a matching agent", async () => {
	const agent = state.agent;
	const other = await request("auth.login", {
		provider: "anthropic",
		method: "api_key",
		api_key: "  sk-ant-test  ",
	});
	expect(other.result).toEqual({
		status: "completed",
		provider: "anthropic",
		method: "api_key",
	});
	expect(state.agent).toBe(agent);
	expect((await store.load()).providers).toEqual({
		...credentials,
		anthropic: { method: "api_key", api_key: "sk-ant-test" },
	});

	await request("auth.login", {
		provider: "openai",
		method: "api_key",
		api_key: "sk-openai-test",
	});
	expect(state.agent).toBeNull();
	expect((await store.load()).providers.openai).toEqual({
		method: "api_key",
		api_key: "sk-openai-test",
	});
});

test("auth.login rejects invalid input, unsupported methods and busy runtimes without writes", async () => {
	for (const params of [
		{ provider: "anthropic", method: "api_key", api_key: "has space" },
		{ provider: "anthropic", method: "api_key", api_key: "" },
		{ provider: "anthropic", method: "oauth" },
		{ provider: "home", method: "device_code" },
		{ provider: "missing", method: "api_key", api_key: "k" },
		{ provider: "openai", method: "password" },
		{ provider: "openai", method: "oauth", callback: "popup" },
	]) {
		expect((await request("auth.login", params)).error?.code).toBe(-32602);
	}
	state.activeRunId = "run-1";
	expect(
		(
			await request("auth.login", {
				provider: "anthropic",
				method: "api_key",
				api_key: "k",
			})
		).error?.code,
	).toBe(-32001);
	expect((await store.load()).providers).toEqual(credentials);
});

test("pasted OAuth login stays pending on bad input and saves tokens on completion", async () => {
	const bodies = mockTokenExchange();
	const started = await request("auth.login", {
		provider: "openai",
		method: "oauth",
		callback: "paste",
	});
	expect(started.result?.status).toBe("pending");
	const loginId = String(started.result?.login_id);
	const authUrl = new URL(String(started.result?.auth_url));
	const oauthState = authUrl.searchParams.get("state");
	expect(oauthState).toBeTruthy();

	const status = await request("auth.status", { provider: "openai" });
	expect(status.result?.pending_login).toEqual({
		login_id: loginId,
		provider: "openai",
		method: "oauth",
	});
	expect(
		(
			await request("auth.login", {
				provider: "openai",
				method: "device_code",
			})
		).error?.code,
	).toBe(-32001);

	const mismatch = await request("auth.login.complete", {
		login_id: loginId,
		callback_input: "code=abc&state=wrong",
	});
	expect(mismatch.error?.code).toBe(-32602);

	const completed = await request("auth.login.complete", {
		login_id: loginId,
		callback_input: `http://localhost:1455/auth/callback?code=abc&state=${oauthState}`,
	});
	expect(completed.result).toEqual({ ok: true });
	const notify = await waitForNotification("auth.login.status");
	expect(notify).toEqual({
		login_id: loginId,
		provider: "openai",
		method: "oauth",
		status: "completed",
	});
	expect(bodies[0]).toContain("code=abc");
	const saved = (await store.load()).providers.openai;
	expect(saved.method).toBe("oauth");
	expect(saved.method === "oauth" && saved.oauth.access_token).toBe(
		"new-access",
	);
	expect((await store.load()).providers.home).toEqual(credentials.home);
	expect(state.agent).toBeNull();
	expect((await request("auth.status")).result?.pending_login).toBeUndefined();
});

test("device-code login can be cancelled without touching credentials", async () => {
	let polls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/accounts/deviceauth/usercode")) {
			return Response.json({
				device_auth_id: "device-1",
				user_code: "CODE-1",
				interval: "0",
			});
		}
		if (url.endsWith("/api/accounts/deviceauth/token")) {
			polls += 1;
			return new Response("pending", { status: 404 });
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;
	const started = await request("auth.login", {
		provider: "openai",
		method: "device_code",
	});
	expect(started.result).toMatchObject({
		status: "pending",
		method: "device_code",
		verification_url: "https://auth.openai.com/codex/device",
		user_code: "CODE-1",
	});
	const loginId = String(started.result?.login_id);
	while (polls < 2) await Bun.sleep(1);
	expect(
		(await request("auth.login.cancel", { login_id: "other" })).result,
	).toEqual({ cancelled: false });
	expect(
		(await request("auth.login.cancel", { login_id: loginId })).result,
	).toEqual({ cancelled: true });
	const notify = await waitForNotification("auth.login.status");
	expect(notify.status).toBe("cancelled");
	await Bun.sleep(20);
	expect(
		(messages as Response[]).filter(
			(message) => message.method === "auth.login.status",
		).length,
	).toBe(1);
	expect((await store.load()).providers).toEqual(credentials);
	expect(state.agent).not.toBeNull();
});

test("pre-confirmed logout skips the UI confirmation request", async () => {
	const response = await request("auth.logout", {
		provider: "home",
		confirmed: true,
	});
	expect(response.result).toMatchObject({ ok: true, provider: "home" });
	expect(
		(messages as Response[]).some(
			(message) => message.method === "ui.confirm.request",
		),
	).toBe(false);
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
	});
	expect(
		(await request("auth.logout", { provider: "home", confirmed: "yes" })).error
			?.code,
	).toBe(-32602);
});

test("clients that manage auth skip startup onboarding", async () => {
	await store.save({ version: 1, providers: {} });
	const onboardingPicks = async (manageAuth: boolean): Promise<number> => {
		messages.length = 0;
		await request("initialize", {
			protocol_version: "0",
			client: { name: "gui", version: "0" },
			ui_capabilities: {
				supports_pick: true,
				supports_prompt: true,
				supports_confirm: true,
				supports_auth_management: manageAuth,
			},
		});
		await Bun.sleep(30);
		const picks = (messages as Response[]).filter(
			(message) => message.method === "ui.pick.request",
		);
		for (const pick of picks) {
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: String(pick.id),
				result: { ids: [] },
			});
		}
		return picks.length;
	};
	expect(await onboardingPicks(true)).toBe(0);
	// Control: the same runtime prompts a client that does not manage auth.
	handlers = createRuntimeHandlers({
		state,
		log: () => {},
		getAgent: async () => {
			throw new Error("Must not create an agent for auth management");
		},
	});
	expect(await onboardingPicks(false)).toBe(1);
});

test("concurrent api_key logins for different providers keep both credentials", async () => {
	await Promise.all([
		request("auth.login", {
			provider: "anthropic",
			method: "api_key",
			api_key: "sk-ant",
		}),
		request("auth.login", {
			provider: "xai",
			method: "api_key",
			api_key: "sk-xai",
		}),
		request("auth.logout", { provider: "home", confirmed: true }),
	]);
	expect((await store.load()).providers).toEqual({
		openai: credentials.openai,
		anthropic: { method: "api_key", api_key: "sk-ant" },
		xai: { method: "api_key", api_key: "sk-xai" },
	});
});

test("a login cancelled before its token exchange settles never saves credentials", async () => {
	let releaseExchange!: () => void;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).endsWith("/oauth/token")) {
			await new Promise<void>((resolve) => {
				releaseExchange = resolve;
			});
			return Response.json({
				access_token: "late-access",
				refresh_token: "late-refresh",
				expires_in: 3600,
			});
		}
		throw new Error(`unexpected fetch: ${String(input)}`);
	}) as unknown as typeof fetch;
	const started = await request("auth.login", {
		provider: "openai",
		method: "oauth",
		callback: "paste",
	});
	const loginId = String(started.result?.login_id);
	const oauthState = new URL(String(started.result?.auth_url)).searchParams.get(
		"state",
	);
	await request("auth.login.complete", {
		login_id: loginId,
		callback_input: `code=abc&state=${oauthState}`,
	});
	expect(
		(await request("auth.login.cancel", { login_id: loginId })).result,
	).toEqual({ cancelled: true });
	while (!releaseExchange) await Bun.sleep(1);
	releaseExchange();
	await Bun.sleep(30);
	const notes = (messages as Response[]).filter(
		(message) => message.method === "auth.login.status",
	);
	expect(notes.map((note) => note.params?.status)).toEqual(["cancelled"]);
	expect((await store.load()).providers).toEqual(credentials);
});

test("concurrent OAuth logins reserve one pending slot", async () => {
	const first = `req-${requestSeq + 1}`;
	const second = `req-${requestSeq + 2}`;
	requestSeq += 2;
	for (const id of [first, second]) {
		handlers.processMessage({
			jsonrpc: "2.0",
			id,
			method: "auth.login",
			params: { provider: "openai", method: "oauth", callback: "paste" },
		});
	}
	const settled = async (id: string) => {
		for (;;) {
			const found = (messages as Response[]).find(
				(message) => message.id === id && !message.method,
			);
			if (found) return found;
			await Bun.sleep(1);
		}
	};
	const responses = await Promise.all([settled(first), settled(second)]);
	expect(
		responses.map(
			(response) => response.result?.status ?? response.error?.code,
		),
	).toEqual(["pending", -32001]);
	const status = await request("auth.status", { provider: "openai" });
	expect(
		(status.result?.pending_login as { login_id?: string })?.login_id,
	).toBe(String(responses[0]?.result?.login_id));
});

test("cancelling while a device-code session is being created stops it", async () => {
	let releaseStart!: () => void;
	let polls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/api/accounts/deviceauth/usercode")) {
			await new Promise<void>((resolve) => {
				releaseStart = resolve;
			});
			return Response.json({
				device_auth_id: "device-1",
				user_code: "CODE-1",
				interval: "0",
			});
		}
		if (url.endsWith("/api/accounts/deviceauth/token")) {
			polls += 1;
			return new Response("pending", { status: 404 });
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as unknown as typeof fetch;
	const id = `req-${++requestSeq}`;
	handlers.processMessage({
		jsonrpc: "2.0",
		id,
		method: "auth.login",
		params: { provider: "openai", method: "device_code" },
	});
	while (!releaseStart) await Bun.sleep(1);
	const status = await request("auth.status", { provider: "openai" });
	const loginId = String(
		(status.result?.pending_login as { login_id?: string } | undefined)
			?.login_id,
	);
	expect(
		(await request("auth.login.cancel", { login_id: loginId })).result,
	).toEqual({ cancelled: true });
	releaseStart();
	for (;;) {
		const found = (messages as Response[]).find(
			(message) => message.id === id && !message.method,
		);
		if (found) {
			expect(found.error?.code).toBe(-32003);
			break;
		}
		await Bun.sleep(1);
	}
	await Bun.sleep(20);
	expect(polls).toBe(0);
	expect(
		(messages as Response[])
			.filter((message) => message.method === "auth.login.status")
			.map((message) => message.params?.status),
	).toEqual(["cancelled"]);
	expect((await request("auth.status")).result?.pending_login).toBeUndefined();
});
