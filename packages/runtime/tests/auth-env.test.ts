import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStoragePaths } from "@codelia/storage";
import { AuthResolver } from "../src/auth/resolver";
import { AuthStore } from "../src/auth/store";
import { RuntimeState } from "../src/runtime-state";

describe("env-var API key non-persistence and precedence", () => {
	let tempRoot = "";
	const envSnapshot = new Map<string, string | undefined>();

	const setEnv = (key: string, value: string | undefined) => {
		if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-auth-env-"));
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
	});

	afterEach(async () => {
		for (const [key, value] of envSnapshot) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		envSnapshot.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("env API key resolves in memory without creating or mutating auth.json", async () => {
		setEnv("OPENAI_API_KEY", "sk-env-only-fixture");
		const resolver = await AuthResolver.create(new RuntimeState(), () => {});
		const auth = await resolver.resolveProviderAuth("openai");
		expect(auth).toEqual({
			method: "api_key",
			api_key: "sk-env-only-fixture",
		});

		const paths = resolveStoragePaths();
		await expect(fs.access(paths.authFile)).rejects.toThrow();
		expect(await new AuthStore().load()).toEqual({
			version: 1,
			providers: {},
		});
	});

	test("stored credentials take precedence over env API keys until cleared", async () => {
		const store = new AuthStore();
		await store.save({
			version: 1,
			providers: {
				anthropic: { method: "api_key", api_key: "sk-stored-fixture" },
			},
		});
		setEnv("ANTHROPIC_API_KEY", "sk-env-fallback-fixture");

		const resolver = await AuthResolver.create(new RuntimeState(), () => {});
		expect(await resolver.resolveProviderAuth("anthropic")).toEqual({
			method: "api_key",
			api_key: "sk-stored-fixture",
		});

		await store.update((file) => {
			delete file.providers.anthropic;
		});
		const afterLogout = await AuthResolver.create(new RuntimeState(), () => {});
		expect(await afterLogout.resolveProviderAuth("anthropic")).toEqual({
			method: "api_key",
			api_key: "sk-env-fallback-fixture",
		});
		expect(await store.load()).toEqual({ version: 1, providers: {} });
	});
});
