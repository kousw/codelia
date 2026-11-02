import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { McpClient } from "../src/mcp/client";
import { HttpMcpClient } from "../src/mcp/http-client";
import { McpManager } from "../src/mcp/manager";

const waitFor = async (predicate: () => boolean | Promise<boolean>) => {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for MCP fixture");
};

const makeFixture = async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-mcp-shutdown-"),
	);
	const workspace = path.join(root, "workspace");
	await fs.mkdir(path.join(workspace, ".codelia"), { recursive: true });
	await fs.writeFile(
		path.join(workspace, ".codelia", "config.json"),
		JSON.stringify({
			version: 1,
			mcp: { servers: { fixture: { transport: "stdio", command: "fixture" } } },
		}),
	);
	return { root, workspace };
};

describe("MCP shutdown", () => {
	test("reentrant shutdown waits for the same clients", async () => {
		const manager = new McpManager({
			workingDir: process.cwd(),
			log: () => {},
		});
		const internals = manager as unknown as {
			clients: Set<McpClient>;
			shutdownController: AbortController;
		};
		let release!: () => void;
		const pendingClose = new Promise<void>((resolve) => {
			release = resolve;
		});
		internals.clients.add({
			request: async () => null,
			notify: async () => {},
			close: () => pendingClose,
		});
		let reentrant: Promise<void> | undefined;
		internals.shutdownController.signal.addEventListener(
			"abort",
			() => {
				reentrant = manager.close();
			},
			{ once: true },
		);
		let finished = false;
		const first = manager.close().then(() => {
			finished = true;
		});
		try {
			await waitFor(() => reentrant !== undefined);
			await Bun.sleep(10);
			expect(finished).toBe(false);
			release();
			await Promise.all([first, reentrant]);
		} finally {
			release();
		}
	});

	test("shutdown aborts an in-flight OAuth confirmation", async () => {
		const manager = new McpManager({
			workingDir: process.cwd(),
			log: () => {},
		});
		const internals = manager as unknown as {
			resolveOAuthConfig: () => Promise<{
				authorization_url: string;
				token_url: string;
			}>;
			requestOAuthTokensForServer: (
				id: string,
				config: unknown,
				reason: string,
				options: {
					requestOAuthTokens: (params: {
						signal: AbortSignal;
					}) => Promise<null>;
				},
			) => Promise<boolean>;
		};
		internals.resolveOAuthConfig = async () => ({
			authorization_url: "https://example.test/auth",
			token_url: "https://example.test/token",
		});
		let observed: AbortSignal | undefined;
		const pending = internals.requestOAuthTokensForServer(
			"fixture",
			{},
			"unauthorized",
			{
				requestOAuthTokens: ({ signal }) => {
					observed = signal;
					return new Promise((resolve) => {
						if (signal.aborted) resolve(null);
						else
							signal.addEventListener("abort", () => resolve(null), {
								once: true,
							});
					});
				},
			},
		);
		await waitFor(() => observed !== undefined);
		await manager.close();
		expect(observed?.aborted).toBe(true);
		expect(await pending).toBe(false);
	});

	test("shutdown waits for a client already closing after connection failure", async () => {
		let release!: () => void;
		const pendingClose = new Promise<void>((resolve) => {
			release = resolve;
		});
		let closeStarted = false;
		const client: McpClient = {
			request: async () => {
				throw new Error("connection failed");
			},
			notify: async () => {},
			close: () => {
				closeStarted = true;
				return pendingClose;
			},
		};
		const manager = new McpManager({
			workingDir: process.cwd(),
			log: () => {},
		});
		const internals = manager as unknown as {
			servers: Map<string, unknown>;
			createClient: () => McpClient;
			connectServer: (id: string) => Promise<void>;
		};
		internals.servers.set("fixture", {
			config: {
				id: "fixture",
				source: "project",
				enabled: true,
				transport: "stdio",
				command: "fixture",
				request_timeout_ms: 2_000,
			},
			state: "connecting",
			toolAdapters: [],
		});
		internals.createClient = () => client;
		const connect = internals.connectServer("fixture");
		try {
			await waitFor(() => closeStarted);
			let shutdownFinished = false;
			const shutdown = manager.close().then(() => {
				shutdownFinished = true;
			});
			await Bun.sleep(10);
			expect(shutdownFinished).toBe(false);
			release();
			await Promise.all([connect, shutdown]);
		} finally {
			release();
		}
	});

	test("closes a connecting client once and does not finish initialization after shutdown", async () => {
		const fixture = await makeFixture();
		const previousLayout = process.env.CODELIA_LAYOUT;
		const previousConfig = process.env.XDG_CONFIG_HOME;
		process.env.CODELIA_LAYOUT = "xdg";
		process.env.XDG_CONFIG_HOME = path.join(fixture.root, "config");
		try {
			let connected = false;
			let closed = 0;
			let notified = 0;
			let release!: (value: unknown) => void;
			const pending = new Promise<unknown>((resolve) => {
				release = resolve;
			});
			const client: McpClient = {
				request: async () => {
					connected = true;
					return pending;
				},
				notify: async () => {
					notified++;
				},
				close: async () => {
					closed++;
				},
			};
			const manager = new McpManager({
				workingDir: fixture.workspace,
				log: () => {},
			});
			(manager as unknown as { createClient: () => McpClient }).createClient =
				() => client;
			const start = manager.start();
			await waitFor(() => connected);
			await Promise.all([manager.close(), manager.close()]);
			release({ capabilities: {} });
			await start;
			expect(closed).toBe(1);
			expect(notified).toBe(0);
			await expect(manager.start()).rejects.toThrow("MCP manager is closed");
		} finally {
			if (previousLayout === undefined) delete process.env.CODELIA_LAYOUT;
			else process.env.CODELIA_LAYOUT = previousLayout;
			if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousConfig;
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});

	test("closing an HTTP client aborts its in-flight requests", async () => {
		const originalFetch = globalThis.fetch;
		let started = false;
		globalThis.fetch = ((_url, options) =>
			new Promise((_resolve, reject) => {
				started = true;
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			})) as typeof fetch;
		try {
			const client = new HttpMcpClient({
				serverId: "fixture",
				url: "https://example.test",
				protocolVersion: "2025-11-25",
				log: () => {},
			});
			const outcome = client
				.request("initialize", {}, { timeoutMs: 2_000 })
				.then(
					() => null,
					(error) => error,
				);
			await waitFor(() => started);
			await client.close();
			expect((await outcome).message).toContain("aborted");
			await expect(client.notify("test", {})).rejects.toThrow("closed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	const testStdio = process.platform === "win32" ? test.skip : test;
	testStdio(
		"runtime EOF cancels OAuth confirmation and releases the callback port",
		async () => {
			const fixture = await makeFixture();
			const portProbe = createServer();
			await new Promise<void>((resolve, reject) => {
				portProbe.once("error", reject);
				portProbe.listen(0, "127.0.0.1", resolve);
			});
			const address = portProbe.address();
			if (!address || typeof address === "string")
				throw new Error("missing callback port");
			const callbackPort = address.port;
			await new Promise<void>((resolve, reject) =>
				portProbe.close((error) => (error ? reject(error) : resolve())),
			);
			const mcpServer = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: (request) =>
					new Response("", { status: request.method === "POST" ? 401 : 404 }),
			});
			await fs.writeFile(
				path.join(fixture.workspace, ".codelia", "config.json"),
				JSON.stringify({
					version: 1,
					mcp: {
						servers: {
							fixture: {
								transport: "http",
								url: `http://127.0.0.1:${mcpServer.port}/mcp`,
								request_timeout_ms: 1_000,
								oauth: {
									authorization_url: "https://example.test/auth",
									token_url: "https://example.test/token",
									client_id: "test-client",
								},
							},
						},
					},
				}),
			);
			const runtime = Bun.spawn({
				cmd: [
					process.execPath,
					path.resolve(import.meta.dir, "../src/index.ts"),
				],
				cwd: fixture.workspace,
				env: {
					...process.env,
					CODELIA_LAYOUT: "xdg",
					CODELIA_MCP_OAUTH_PORT: String(callbackPort),
					XDG_CONFIG_HOME: path.join(fixture.root, "config"),
					XDG_STATE_HOME: path.join(fixture.root, "state"),
					XDG_CACHE_HOME: path.join(fixture.root, "cache"),
					XDG_DATA_HOME: path.join(fixture.root, "data"),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			const reader = runtime.stdout.getReader();
			try {
				runtime.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize", params: { client: { name: "test", version: "1" }, ui_capabilities: { supports_confirm: true } } })}\n`,
				);
				const readConfirmation = async () => {
					let buffer = "";
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) return false;
						buffer += new TextDecoder().decode(chunk.value);
						let index = buffer.indexOf("\n");
						while (index >= 0) {
							const line = buffer.slice(0, index);
							buffer = buffer.slice(index + 1);
							if (line && JSON.parse(line).method === "ui.confirm.request")
								return true;
							index = buffer.indexOf("\n");
						}
					}
				};
				const sawConfirm = await Promise.race([
					readConfirmation(),
					Bun.sleep(3_000).then(() => false),
				]);
				expect(sawConfirm).toBe(true);
				runtime.stdin.end();
				const exited = await Promise.race([
					runtime.exited,
					Bun.sleep(2_000).then(() => null),
				]);
				expect(exited).toBe(0);
				const probe = createServer();
				await new Promise<void>((resolve, reject) => {
					probe.once("error", reject);
					probe.listen(callbackPort, "127.0.0.1", resolve);
				});
				await new Promise<void>((resolve, reject) =>
					probe.close((error) => (error ? reject(error) : resolve())),
				);
			} finally {
				if (runtime.exitCode === null) runtime.kill();
				await runtime.exited;
				await reader.cancel().catch(() => {});
				mcpServer.stop(true);
				await fs.rm(fixture.root, { recursive: true, force: true });
			}
		},
	);

	testStdio("runtime EOF closes an active stdio MCP server", async () => {
		const fixture = await makeFixture();
		const ready = path.join(fixture.root, "ready");
		const stopped = path.join(fixture.root, "stopped");
		const fakeServer = path.join(fixture.root, "server.cjs");
		await fs.writeFile(
			fakeServer,
			`
const fs = require("node:fs");
const readline = require("node:readline");
process.on("SIGTERM", () => { fs.writeFileSync(process.argv[3], "stopped"); process.exit(0); });
setTimeout(() => process.exit(0), 5000);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {} } }) + "\\n");
  if (msg.method === "notifications/initialized") fs.writeFileSync(process.argv[2], "ready");
});
`,
		);
		await fs.writeFile(
			path.join(fixture.workspace, ".codelia", "config.json"),
			JSON.stringify({
				version: 1,
				mcp: {
					servers: {
						fixture: {
							transport: "stdio",
							command: process.execPath,
							args: [fakeServer, ready, stopped],
						},
					},
				},
			}),
		);
		const runtime = Bun.spawn({
			cmd: [process.execPath, path.resolve(import.meta.dir, "../src/index.ts")],
			cwd: fixture.workspace,
			env: {
				...process.env,
				CODELIA_LAYOUT: "xdg",
				XDG_CONFIG_HOME: path.join(fixture.root, "config"),
				XDG_STATE_HOME: path.join(fixture.root, "state"),
				XDG_CACHE_HOME: path.join(fixture.root, "cache"),
				XDG_DATA_HOME: path.join(fixture.root, "data"),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await waitFor(async () =>
				fs.stat(ready).then(
					() => true,
					() => false,
				),
			);
			runtime.stdin.end();
			const exited = await Promise.race([
				runtime.exited,
				Bun.sleep(2_000).then(() => null),
			]);
			expect(exited).toBe(0);
			await waitFor(async () =>
				fs.stat(stopped).then(
					() => true,
					() => false,
				),
			);
		} finally {
			if (runtime.exitCode === null) runtime.kill();
			await runtime.exited;
			await fs.rm(fixture.root, { recursive: true, force: true });
		}
	});
});
