import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuthResolver, SUPPORTED_PROVIDERS } from "../src/auth/resolver";
import { RuntimeState } from "../src/runtime-state";

describe("zai auth", () => {
	let tempRoot = "";
	const envSnapshot = new Map<string, string | undefined>();

	const setEnv = (key: string, value: string) => {
		envSnapshot.set(key, process.env[key]);
		process.env[key] = value;
	};

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-zai-auth-"));
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));
		setEnv("ZAI_API_KEY", "test-zai-key");
	});

	afterEach(async () => {
		for (const [key, value] of envSnapshot) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		envSnapshot.clear();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	test("supports ZAI_API_KEY env auth", async () => {
		expect(SUPPORTED_PROVIDERS).toContain("zai");
		const resolver = await AuthResolver.create(new RuntimeState(), () => {});
		const auth = await resolver.resolveProviderAuth("zai");
		expect(auth).toEqual({ method: "api_key", api_key: "test-zai-key" });
	});
});
