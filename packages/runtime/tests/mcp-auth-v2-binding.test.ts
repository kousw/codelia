import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CredentialConflictError,
	ensureCredentialsDirectory,
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

	test("does not prepare credential storage for disabled MCP servers", async () => {
		await Bun.write(
			path.join(root, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						disabled: {
							enabled: false,
							transport: "http",
							url: "https://mcp.example.test/tools",
						},
					},
				},
			}),
		);
		const manager = new McpManager({ workingDir: root, log: () => {} });
		try {
			await manager.start();
			expect(manager.list().servers).toEqual([
				expect.objectContaining({ id: "disabled", state: "disabled" }),
			]);
			await expect(
				fs.access(resolveStoragePaths().credentialsDir),
			).rejects.toThrow("ENOENT");
		} finally {
			await manager.close();
		}
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

	test("login, reconnect and 401 refresh share the configured destination when OAuth advertises a different resource", async () => {
		const url = "https://mcp.example.test/tools";
		const resource = `${url}/`;
		const issuer = "https://auth.example.test/tenant";
		await Bun.write(
			path.join(root, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: { servers: { primary: { transport: "http", url } } },
			}),
		);
		let expectedToken = "first";
		const headersSeen: Array<string | null> = [];
		const refreshForms: URLSearchParams[] = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const dest = new URL(String(input));
				if (dest.pathname.endsWith("/oauth-protected-resource")) {
					return Response.json({ resource, authorization_servers: [issuer] });
				}
				if (
					dest.pathname.startsWith("/.well-known/oauth-authorization-server")
				) {
					return Response.json({
						issuer,
						token_endpoint: `${issuer}/token`,
						authorization_endpoint: `${issuer}/login`,
					});
				}
				if (dest.href === `${issuer}/token`) {
					refreshForms.push(new URLSearchParams(String(init?.body)));
					return Response.json({ access_token: expectedToken });
				}
				if (dest.href !== url) throw new Error("unexpected MCP destination");
				const auth = new Headers(init?.headers).get("authorization");
				headersSeen.push(auth);
				if (auth !== `Bearer ${expectedToken}`)
					return new Response("", { status: 401 });
				const rpc = JSON.parse(String(init?.body));
				return Response.json({
					jsonrpc: "2.0",
					id: rpc.id,
					result: { protocolVersion: "2025-11-25", capabilities: {} },
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		const store = new McpAuthStore();
		const login = new McpManager({ workingDir: root, log: () => {} });
		try {
			await login.start({
				requestOAuthTokens: async ({ oauth }) => {
					expect(oauth.resource).toBe(resource);
					return {
						access_token: "first",
						refresh_token: "fixture-refresh",
						client_id: "dynamic-client",
					};
				},
			});
		} finally {
			await login.close();
		}
		const binding = {
			resource_uri: url,
			issuer,
			token_endpoint: `${issuer}/token`,
			client_id: "dynamic-client",
		};
		expect((await store.load()).servers.primary?.binding).toEqual(binding);
		expectedToken = "second";
		headersSeen.length = 0;
		const reconnect = new McpManager({ workingDir: root, log: () => {} });
		try {
			await reconnect.start();
			expect(headersSeen.slice(0, 2)).toEqual([
				"Bearer first",
				"Bearer second",
			]);
			expect(refreshForms).toHaveLength(1);
			expect(refreshForms[0].get("resource")).toBe(resource);
			expect((await store.load()).servers.primary).toMatchObject({
				binding,
				tokens: { access_token: "second" },
			});
		} finally {
			await reconnect.close();
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
		await ensureCredentialsDirectory(paths.credentialsDir);
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

	test("refuses stored token and client_secret when same resource_uri discovers a different OAuth issuer or cannot confirm issuer", async () => {
		const store = new McpAuthStore();
		await store.save({
			version: 2,
			servers: {
				docs: {
					binding: {
						resource_uri: "https://mcp.example.test/mcp",
						issuer: "https://issuer-a.example.test",
						token_endpoint: "https://issuer-a.example.test/oauth/token",
						client_id: "dcr-client-a",
					},
					tokens: {
						access_token: "secret-issuer-a-token",
						refresh_token: "secret-issuer-a-refresh",
						client_id: "dcr-client-a",
						client_secret: "secret-issuer-a-client-secret",
					},
				},
			},
		});

		const workspace = path.join(root, "project-issuer-swap");
		await fs.mkdir(path.join(workspace, ".codelia"), { recursive: true });
		// Config specifies only the resource URL (no static oauth endpoints) — discovery
		// is required to confirm the issuer before attaching the stored token.
		await fs.writeFile(
			path.join(workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						docs: {
							transport: "http",
							url: "https://mcp.example.test/mcp",
						},
					},
				},
			}),
		);

		const seenAuthHeaders: Array<string | null> = [];
		let promptedOAuth: Record<string, unknown> | null = null;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (
					url.startsWith(
						"https://mcp.example.test/.well-known/oauth-protected-resource",
					)
				) {
					return Response.json({
						resource: "https://mcp.example.test/mcp",
						authorization_servers: ["https://issuer-b.example.test"],
					});
				}
				if (
					url.startsWith(
						"https://issuer-b.example.test/.well-known/oauth-authorization-server",
					)
				) {
					return Response.json({
						issuer: "https://issuer-b.example.test",
						authorization_endpoint: "https://issuer-b.example.test/authorize",
						token_endpoint: "https://issuer-b.example.test/oauth/token",
					});
				}
				if (url === "https://mcp.example.test/mcp") {
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
			await manager.start({
				requestOAuthTokens: async ({ oauth }) => {
					promptedOAuth = oauth as Record<string, unknown>;
					return null;
				},
			});
			// Stored issuer-a bearer token must NEVER be sent to issuer-b.
			expect(
				seenAuthHeaders.some((h) => h?.includes("secret-issuer-a-token")),
			).toBe(false);
			// Stored issuer-a client_secret / client_id must NEVER leak into issuer-b prompt.
			const captured = promptedOAuth as Record<string, unknown> | null;
			expect(captured).not.toBeNull();
			expect(captured?.client_secret).toBeUndefined();
			expect(captured?.client_id).toBeUndefined();
		} finally {
			await manager.close();
		}
	});

	test("refuses stored issuer-bound token when discovery fails and issuer cannot be confirmed", async () => {
		const store = new McpAuthStore();
		await store.save({
			version: 2,
			servers: {
				docs: {
					binding: {
						resource_uri: "https://mcp.example.test/mcp",
						issuer: "https://issuer-a.example.test",
						token_endpoint: "https://issuer-a.example.test/oauth/token",
					},
					tokens: {
						access_token: "secret-unverified-token",
					},
				},
			},
		});

		const workspace = path.join(root, "project-no-discovery");
		await fs.mkdir(path.join(workspace, ".codelia"), { recursive: true });
		await fs.writeFile(
			path.join(workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						docs: {
							transport: "http",
							url: "https://mcp.example.test/mcp",
						},
					},
				},
			}),
		);

		const seenAuthHeaders: Array<string | null> = [];
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://mcp.example.test/mcp") {
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
			expect(
				seenAuthHeaders.some((h) => h?.includes("secret-unverified-token")),
			).toBe(false);
		} finally {
			await manager.close();
		}
	});
});
