import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderFailureError } from "@codelia/core";
import { McpAuthStore } from "@codelia/storage";
import { refreshAccessToken } from "../src/auth/openai-oauth";
import { McpManager } from "../src/mcp/manager";

describe("bounded OAuth refresh and MCP locked 401 refresh", () => {
	const originalFetch = globalThis.fetch;
	const env = new Map<string, string | undefined>();
	let root = "";

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), "codelia-mcp-refresh-"));
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

	test("refreshAccessToken aborts hung requests at its internal timeout", async () => {
		globalThis.fetch = Object.assign(
			async (_url: RequestInfo | URL, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason ?? new Error("aborted")),
						{ once: true },
					);
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const error = await refreshAccessToken("fixture-refresh", undefined, {
			timeoutMs: 40,
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(ProviderFailureError);
		expect((error as ProviderFailureError).failure.code).toBe(
			"oauth_refresh_timeout",
		);
		expect((error as ProviderFailureError).failure.retryable).toBe(true);
	});

	test("MCP 401 refreshes an unexpired token once and preserves sibling server entries", async () => {
		const store = new McpAuthStore();
		await store.save({
			version: 2,
			servers: {
				primary: {
					binding: {
						resource_uri: "https://mcp.example.test/rpc",
						issuer: "https://auth.example.test",
						token_endpoint: "https://auth.example.test/token",
					},
					tokens: {
						access_token: "stale-but-unexpired",
						refresh_token: "refresh-1",
						expires_at: Date.now() + 3_600_000,
					},
				},
				sibling: {
					binding: {
						resource_uri: "https://sibling.example.test/rpc",
					},
					tokens: {
						access_token: "sibling-token",
					},
				},
			},
		});

		let refreshCalls = 0;
		let mcpCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://auth.example.test/token") {
					refreshCalls++;
					// Simulate sibling server update happening concurrently before save
					return Response.json({
						access_token: "fresh-token-after-401",
						refresh_token: "refresh-2",
						expires_in: 3600,
					});
				}
				if (url === "https://mcp.example.test/rpc") {
					mcpCalls++;
					const authHeader = new Headers(init?.headers).get("Authorization");
					if (authHeader === "Bearer stale-but-unexpired") {
						return new Response("unauthorized", { status: 401 });
					}
					const body = JSON.parse(String(init?.body)) as {
						id?: string;
						method: string;
					};
					if (body.method === "initialize") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "example", version: "1.0.0" },
							},
						});
					}
					if (body.method === "tools/list") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: { tools: [] },
						});
					}
					return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const manager = new McpManager({
			workingDir: root,
			log: () => {},
		});
		// Inject resolved server directly via project config
		await Bun.write(
			path.join(root, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						primary: {
							transport: "http",
							url: "https://mcp.example.test/rpc",
							oauth: {
								authorization_url: "https://auth.example.test/authorize",
								token_url: "https://auth.example.test/token",
							},
						},
					},
				},
			}),
		);

		try {
			await manager.start();
			expect(refreshCalls).toBe(1);
			expect(mcpCalls).toBeGreaterThanOrEqual(2);
			const saved = await store.load();
			expect(saved.servers.primary?.tokens.access_token).toBe(
				"fresh-token-after-401",
			);
			expect(saved.servers.sibling?.tokens.access_token).toBe("sibling-token");
		} finally {
			await manager.close();
		}
	});

	test("MCP 401 reuses a token already rotated by a sibling process without refreshing again", async () => {
		const store = new McpAuthStore();
		await store.save({
			version: 2,
			servers: {
				primary: {
					binding: {
						resource_uri: "https://mcp.example.test/rpc",
						issuer: "https://auth.example.test",
						token_endpoint: "https://auth.example.test/token",
					},
					tokens: {
						access_token: "stale-token",
						refresh_token: "refresh-1",
					},
				},
			},
		});

		let refreshCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url === "https://auth.example.test/token") {
					refreshCalls++;
					return Response.json({ access_token: "should-not-be-called" });
				}
				if (url === "https://mcp.example.test/rpc") {
					const authHeader = new Headers(init?.headers).get("Authorization");
					if (authHeader === "Bearer stale-token") {
						// Another process rotated the token on disk while our 401 was in flight
						await store.update((auth) => {
							auth.servers.primary = {
								binding: {
									resource_uri: "https://mcp.example.test/rpc",
									issuer: "https://auth.example.test",
									token_endpoint: "https://auth.example.test/token",
								},
								tokens: {
									access_token: "sibling-rotated-token",
									refresh_token: "refresh-2",
								},
							};
						});
						return new Response("unauthorized", { status: 401 });
					}
					expect(authHeader).toBe("Bearer sibling-rotated-token");
					const body = JSON.parse(String(init?.body)) as {
						id?: string;
						method: string;
					};
					if (body.method === "initialize") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-11-25",
								capabilities: { tools: {} },
								serverInfo: { name: "example", version: "1.0.0" },
							},
						});
					}
					if (body.method === "tools/list") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: { tools: [] },
						});
					}
					return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		await Bun.write(
			path.join(root, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						primary: {
							transport: "http",
							url: "https://mcp.example.test/rpc",
							oauth: {
								authorization_url: "https://auth.example.test/authorize",
								token_url: "https://auth.example.test/token",
							},
						},
					},
				},
			}),
		);

		const manager = new McpManager({
			workingDir: root,
			log: () => {},
		});
		try {
			await manager.start();
			expect(refreshCalls).toBe(0);
		} finally {
			await manager.close();
		}
	});
});
