import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpAuthStore } from "@codelia/storage";
import { runMcpAuthCommand } from "../src/commands/mcp-auth";
import { runMcpConfigCommand } from "../src/commands/mcp-config";

describe("mcp config command", () => {
	let originalCwd = "";
	let originalConfigPath = "";

	beforeEach(() => {
		originalCwd = process.cwd();
		originalConfigPath = process.env.CODELIA_CONFIG_PATH ?? "";
	});

	test("list ignores invalid server entries and keeps valid entries", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codelia-cli-mcp-"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigDir = path.join(projectDir, ".codelia");
		const projectConfigPath = path.join(projectConfigDir, "config.json");
		const globalConfigPath = path.join(tempRoot, "global-config.json");
		await mkdir(projectConfigDir, { recursive: true });
		await writeFile(
			globalConfigPath,
			JSON.stringify({ version: 1, mcp: { servers: {} } }, null, 2),
		);
		await writeFile(
			projectConfigPath,
			JSON.stringify(
				{
					version: 1,
					mcp: {
						servers: {
							valid: {
								transport: "http",
								url: "https://example.com/mcp",
								request_timeout_ms: 123.4,
							},
							invalid: {
								transport: "http",
								url: 123,
							},
						},
					},
				},
				null,
				2,
			),
		);
		process.chdir(projectDir);
		process.env.CODELIA_CONFIG_PATH = globalConfigPath;

		const lines: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			lines.push(args.map((value) => String(value)).join(" "));
		};
		try {
			const exitCode = await runMcpConfigCommand("list", [
				"--scope",
				"project",
			]);
			expect(exitCode).toBe(0);
		} finally {
			console.log = originalLog;
			process.chdir(originalCwd);
			if (originalConfigPath) {
				process.env.CODELIA_CONFIG_PATH = originalConfigPath;
			} else {
				delete process.env.CODELIA_CONFIG_PATH;
			}
			await rm(tempRoot, { recursive: true, force: true });
		}

		expect(
			lines.some((line) => line.includes("valid\thttp\tproject\ttrue")),
		).toBe(true);
		expect(lines.some((line) => line.includes("invalid"))).toBe(false);
	});

	test("auth set and HTTP probe agree on the destination and discovered issuer", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "codelia-cli-binding-"));
		const url = "https://mcp.test/rpc";
		const issuer = "https://auth.test/tenant";
		const originalFetch = globalThis.fetch;
		const env = {
			CODELIA_LAYOUT: "xdg",
			XDG_CONFIG_HOME: path.join(root, "config"),
			XDG_STATE_HOME: path.join(root, "state"),
			XDG_DATA_HOME: path.join(root, "data"),
			XDG_CACHE_HOME: path.join(root, "cache"),
			CODELIA_CONFIG_PATH: path.join(root, "global.json"),
		};
		const previous = new Map(
			Object.keys(env).map((key) => [key, process.env[key]]),
		);
		const bearers: Array<string | null> = [];
		try {
			Object.assign(process.env, env);
			process.chdir(root);
			await writeFile(
				env.CODELIA_CONFIG_PATH,
				JSON.stringify({
					version: 1,
					mcp: { servers: { example: { transport: "http", url } } },
				}),
			);
			globalThis.fetch = Object.assign(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const endpoint = new URL(String(input));
					if (endpoint.pathname.endsWith("/oauth-protected-resource"))
						return Response.json({
							resource: `${url}/`,
							authorization_servers: [issuer],
						});
					if (
						endpoint.pathname.startsWith(
							"/.well-known/oauth-authorization-server",
						)
					)
						return Response.json({
							issuer,
							authorization_endpoint: `${issuer}/authorize`,
							token_endpoint: `${issuer}/token`,
						});
					if (endpoint.href !== url) throw new Error("unexpected endpoint");
					bearers.push(new Headers(init?.headers).get("Authorization"));
					const body = JSON.parse(String(init?.body));
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { protocolVersion: "2025-11-25", tools: [] },
					});
				},
				{ preconnect: originalFetch.preconnect },
			) as typeof fetch;
			expect(
				await runMcpAuthCommand([
					"set",
					"example",
					"--access-token",
					"000042",
					"--refresh-token",
					"rotate",
					"--client-id",
					"test-client",
				]),
			).toBe(0);
			expect(
				(await new McpAuthStore().load()).servers.example?.binding,
			).toEqual({
				resource_uri: url,
				issuer,
				token_endpoint: `${issuer}/token`,
				client_id: "test-client",
			});
			expect(await runMcpConfigCommand("test", ["example"])).toBe(0);
			expect(bearers).toEqual(Array(3).fill("Bearer 000042"));
		} finally {
			globalThis.fetch = originalFetch;
			process.chdir(originalCwd);
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	test("add/disable/remove updates project mcp config", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codelia-cli-mcp-"));
		const projectDir = path.join(tempRoot, "project");
		const projectConfigDir = path.join(projectDir, ".codelia");
		const projectConfigPath = path.join(projectConfigDir, "config.json");
		const globalConfigPath = path.join(tempRoot, "global-config.json");
		await mkdir(projectConfigDir, { recursive: true });
		await writeFile(globalConfigPath, JSON.stringify({ version: 1 }, null, 2));
		process.chdir(projectDir);
		process.env.CODELIA_CONFIG_PATH = globalConfigPath;

		try {
			const addExit = await runMcpConfigCommand("add", [
				"local",
				"--transport",
				"stdio",
				"--command",
				"npx",
				"--scope",
				"project",
			]);
			expect(addExit).toBe(0);

			const disableExit = await runMcpConfigCommand("disable", [
				"local",
				"--scope",
				"project",
			]);
			expect(disableExit).toBe(0);

			const disabledRaw = JSON.parse(await readFile(projectConfigPath, "utf8"));
			expect(disabledRaw.mcp.servers.local.enabled).toBe(false);

			const removeExit = await runMcpConfigCommand("remove", [
				"local",
				"--scope",
				"project",
			]);
			expect(removeExit).toBe(0);

			const removedRaw = JSON.parse(await readFile(projectConfigPath, "utf8"));
			expect(removedRaw).toEqual({ version: 1 });
		} finally {
			process.chdir(originalCwd);
			if (originalConfigPath) {
				process.env.CODELIA_CONFIG_PATH = originalConfigPath;
			} else {
				delete process.env.CODELIA_CONFIG_PATH;
			}
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
