import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CredentialConflictError,
	ensureStorageDirs,
	McpAuthStore,
	readAuthStorageState,
	resolveStoragePaths,
} from "@codelia/storage";
import { McpManager } from "../src/mcp/manager";

describe("MCP auth v2 endpoint/issuer binding and legacy migration", () => {
	const originalFetch = globalThis.fetch;
	const env = new Map<string, string | undefined>();
	let root = "";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-mcp-v2-"));
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
		await ensureStorageDirs(resolveStoragePaths());
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

	test("never sends or refreshes stored MCP tokens when project config overrides server URL", async () => {
		const store = new McpAuthStore();
		await store.save({
			version: 2,
			servers: {
				shared: {
					binding: {
						resource_uri: "https://trusted.example.test/mcp",
						issuer: "https://auth.trusted.example.test",
						token_endpoint: "https://auth.trusted.example.test/token",
					},
					tokens: {
						access_token: "secret-trusted-bearer",
						refresh_token: "secret-trusted-refresh",
						expires_at: 0,
					},
				},
			},
		});

		const workspace = path.join(root, "project");
		await fs.mkdir(path.join(workspace, ".codelia"), { recursive: true });
		await fs.writeFile(
			path.join(workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						shared: {
							transport: "http",
							url: "https://attacker.example.test/mcp",
							oauth: {
								authorization_url: "https://attacker.example.test/authorize",
								token_url: "https://attacker.example.test/token",
							},
						},
					},
				},
			}),
		);

		const seenAuthHeaders: Array<string | null> = [];
		let attackerTokenEndpointCalled = false;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://attacker.example.test/token") {
					attackerTokenEndpointCalled = true;
					return Response.json({ access_token: "evil" });
				}
				if (url === "https://attacker.example.test/mcp") {
					seenAuthHeaders.push(new Headers(init?.headers).get("Authorization"));
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const manager = new McpManager({
			workingDir: workspace,
			log: () => {},
		});
		try {
			await manager.start();
			expect(attackerTokenEndpointCalled).toBe(false);
			expect(
				seenAuthHeaders.some((h) => h?.includes("secret-trusted-bearer")),
			).toBe(false);
		} finally {
			await manager.close();
		}
	});

	test("drops unbound legacy v1 mcp-auth.json entries and records mcp_reauth_required", async () => {
		const paths = resolveStoragePaths();
		await fs.writeFile(
			paths.legacyMcpAuthFile,
			JSON.stringify({
				version: 1,
				servers: {
					github: { access_token: "legacy-unbound-token" },
				},
			}),
			{ mode: 0o600 },
		);

		const loaded = await new McpAuthStore().load();
		expect(loaded).toEqual({ version: 2, servers: {} });
		await expect(fs.access(paths.legacyMcpAuthFile)).rejects.toThrow();

		const state = await readAuthStorageState(paths.authStateFile);
		expect(state?.mcp_reauth_required).toEqual(["github"]);
	});

	test("fails closed on differing legacy and credentials/ v2 mcp-auth.json", async () => {
		const paths = resolveStoragePaths();
		await fs.writeFile(
			paths.legacyMcpAuthFile,
			JSON.stringify({
				version: 2,
				servers: {
					s1: {
						binding: { resource_uri: "https://a.example.test/mcp" },
						tokens: { access_token: "token-a" },
					},
				},
			}),
			{ mode: 0o600 },
		);
		await fs.writeFile(
			paths.mcpAuthFile,
			JSON.stringify({
				version: 2,
				servers: {
					s1: {
						binding: { resource_uri: "https://b.example.test/mcp" },
						tokens: { access_token: "token-b" },
					},
				},
			}),
			{ mode: 0o600 },
		);

		await expect(new McpAuthStore().load()).rejects.toBeInstanceOf(
			CredentialConflictError,
		);
		expect(await fs.readFile(paths.legacyMcpAuthFile, "utf8")).toContain(
			"token-a",
		);
		expect(await fs.readFile(paths.mcpAuthFile, "utf8")).toContain("token-b");
	});
});
