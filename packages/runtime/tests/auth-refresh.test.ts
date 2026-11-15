import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthResolver } from "../src/auth/resolver";
import { AuthStore } from "../src/auth/store";
import { RuntimeState } from "../src/runtime-state";

const originalFetch = globalThis.fetch;
const env = new Map<string, string | undefined>();
let root: string;
let store: AuthStore;
const oauth = {
	access_token: "fixture-access-old",
	refresh_token: "fixture-refresh-old",
	expires_at: 0,
};

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-auth-refresh-"));
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
	store = new AuthStore();
	await store.save({
		version: 1,
		providers: { openai: { method: "oauth", oauth } },
	});
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	env.clear();
	await rm(root, { recursive: true, force: true });
});

const resolver = () => AuthResolver.create(new RuntimeState(), () => {});

const mockRefresh = () => {
	let calls = 0;
	globalThis.fetch = Object.assign(
		async () => {
			calls++;
			await Bun.sleep(10);
			return Response.json({
				access_token: "fixture-access-new",
				refresh_token: "fixture-refresh-new",
				expires_in: 3600,
			});
		},
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	return () => calls;
};

test("concurrent resolvers refresh a rotating credential only once", async () => {
	const first = await resolver();
	const second = await resolver();
	const calls = mockRefresh();
	const tokens = await Promise.all([
		first.getOpenAiAccessToken(),
		first.getOpenAiAccessToken(),
		second.getOpenAiAccessToken(),
	]);
	expect(tokens.map((token) => token.token)).toEqual(
		Array(3).fill("fixture-access-new"),
	);
	expect(calls()).toBe(1);
	expect((await store.load()).providers.openai).toMatchObject({
		oauth: { refresh_token: "fixture-refresh-new" },
	});
});

test("expired cached auth reloads a credential already refreshed by another client", async () => {
	const cached = await resolver();
	await store.update((auth) => {
		auth.providers.openai = {
			method: "oauth",
			oauth: {
				...oauth,
				access_token: "fixture-access-latest",
				refresh_token: "fixture-refresh-latest",
				expires_at: Date.now() + 3600_000,
			},
		};
	});
	const calls = mockRefresh();
	expect((await cached.getOpenAiAccessToken()).token).toBe(
		"fixture-access-latest",
	);
	expect(calls()).toBe(0);
});

test("rejected refresh preserves saved credentials and releases the update queue", async () => {
	const cached = await resolver();
	globalThis.fetch = Object.assign(
		async () => Response.json({ error: "invalid_grant" }, { status: 401 }),
		{ preconnect: originalFetch.preconnect },
	) as typeof fetch;
	await expect(cached.getOpenAiAccessToken()).rejects.toMatchObject({
		failure: { kind: "auth", status: 401 },
	});
	expect((await store.load()).providers.openai).toEqual({
		method: "oauth",
		oauth,
	});
	const calls = mockRefresh();
	expect((await cached.getOpenAiAccessToken()).token).toBe(
		"fixture-access-new",
	);
	expect(calls()).toBe(1);
});
