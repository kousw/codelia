import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpAuthStore } from "../src/mcp/auth-store";

describe("McpAuthStore", () => {
	test("save/load roundtrip", async () => {
		const tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-mcp-auth-"),
		);
		const restore: Array<[string, string | undefined]> = [];
		const setEnv = (key: string, value: string) => {
			restore.push([key, process.env[key]]);
			process.env[key] = value;
		};
		setEnv("CODELIA_LAYOUT", "xdg");
		setEnv("XDG_STATE_HOME", path.join(tempRoot, "state"));
		setEnv("XDG_CACHE_HOME", path.join(tempRoot, "cache"));
		setEnv("XDG_CONFIG_HOME", path.join(tempRoot, "config"));
		setEnv("XDG_DATA_HOME", path.join(tempRoot, "data"));

		try {
			const store = new McpAuthStore();
			await store.save({
				version: 1,
				servers: {
					remote: {
						access_token: "token-a",
						refresh_token: "refresh-a",
						expires_at: 1760000000000,
						token_type: "Bearer",
						scope: "files:read",
						client_id: "client-a",
						client_secret: "secret-a",
					},
				},
			});
			const loaded = await store.load();
			expect(loaded).toEqual({
				version: 1,
				servers: {
					remote: {
						access_token: "token-a",
						refresh_token: "refresh-a",
						expires_at: 1760000000000,
						token_type: "Bearer",
						scope: "files:read",
						client_id: "client-a",
						client_secret: "secret-a",
					},
				},
			});
		} finally {
			for (const [key, value] of restore.reverse()) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});
