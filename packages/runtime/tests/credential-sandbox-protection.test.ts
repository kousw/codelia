import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import { detectInlineMcpConfigSecrets } from "../src/mcp/config-secret-warnings";
import {
	selectProtectedShellBackend,
	workspacePathProtection,
} from "../src/permissions/shell-backend";
import { SandboxContext, SecurityError } from "../src/sandbox/context";

describe("credentials directory default sandbox protection and inline MCP warnings", () => {
	let root = "";
	const env = new Map<string, string | undefined>();

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-cred-sandbox-"));
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
		for (const [key, value] of env) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		env.clear();
		await fs.rm(root, { recursive: true, force: true });
	});

	test("built-in SandboxContext blocks credentials dir and legacy auth files across all sandbox modes", async () => {
		const workspace = path.join(root, "workspace");
		await fs.mkdir(workspace, { recursive: true });
		const paths = resolveStoragePaths();
		await fs.writeFile(paths.authFile, '{"version":1,"providers":{}}', {
			mode: 0o600,
		});
		await fs.writeFile(
			path.join(paths.credentialsDir, ".auth.json.temp.tmp"),
			'{"version":1,"providers":{}}',
			{ mode: 0o600 },
		);
		await fs.writeFile(paths.legacyAuthFile, '{"version":1,"providers":{}}', {
			mode: 0o600,
		});
		await fs.writeFile(paths.configFile, '{"version":1}\n', { mode: 0o644 });

		for (const sandboxMode of [
			"readonly",
			"workspace-write",
			"full-access",
		] as const) {
			const ctx = await SandboxContext.create(workspace, {
				sandboxMode,
				protectResources: true,
			});
			expect(() => ctx.resolvePath(paths.authFile, "read")).toThrow(
				SecurityError,
			);
			expect(() =>
				ctx.resolvePath(
					path.join(paths.credentialsDir, ".auth.json.temp.tmp"),
					"read",
				),
			).toThrow(SecurityError);
			expect(() => ctx.resolvePath(paths.legacyAuthFile, "read")).toThrow(
				SecurityError,
			);
			expect(() => ctx.resolvePath(paths.mcpAuthFile, "read")).toThrow(
				SecurityError,
			);
			expect(ctx.resolvePath(paths.configFile, "read")).toBe(
				await fs.realpath(paths.configFile),
			);
		}
	});

	test.skipIf(process.platform !== "darwin")(
		"macOS Seatbelt blocks confined shell from reading credentials dir, temp files, and legacy auth while allowing config.json",
		async () => {
			const workspace = path.join(root, "workspace");
			await fs.mkdir(workspace, { recursive: true });
			const realWorkspace = await fs.realpath(workspace);
			const paths = resolveStoragePaths();
			await fs.writeFile(paths.authFile, '{"secret":"cred-file"}', {
				mode: 0o600,
			});
			const tempFile = path.join(paths.credentialsDir, ".auth.json.123.tmp");
			await fs.writeFile(tempFile, '{"secret":"temp-file"}', { mode: 0o600 });
			await fs.writeFile(paths.legacyAuthFile, '{"secret":"legacy-file"}', {
				mode: 0o600,
			});
			await fs.writeFile(paths.configFile, '{"version":1}\n', { mode: 0o644 });

			const backend = selectProtectedShellBackend({ allowStandard: true });
			if (!backend) throw new Error("expected macOS Seatbelt backend");
			const protection = {
				profile: "development" as const,
				root: realWorkspace,
				cwd: realWorkspace,
				stdin: "closed" as const,
				writeRoots: [realWorkspace],
				network: "deny" as const,
				...workspacePathProtection(realWorkspace, [], [], "workspace-write"),
			};

			const runShell = async (
				source: string,
			): Promise<{ code: number; stdout: string }> => {
				const child = backend.launch(
					{
						kind: "source",
						executable: "/bin/bash",
						dialect: "bash",
						options: ["--noprofile", "--norc", "-c"],
						source,
					},
					protection,
				);
				let stdout = "";
				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
				});
				const code = await new Promise<number>((resolve, reject) => {
					child.once("error", reject);
					child.once("close", (exitCode) => resolve(exitCode ?? -1));
				});
				return { code, stdout };
			};

			for (const forbidden of [
				paths.authFile,
				tempFile,
				paths.legacyAuthFile,
			]) {
				const res = await runShell(`cat ${JSON.stringify(forbidden)}`);
				expect(res.code).not.toBe(0);
				expect(res.stdout).toBe("");
			}

			const okConfig = await runShell(
				`cat ${JSON.stringify(paths.configFile)}`,
			);
			expect(okConfig.code).toBe(0);
			expect(okConfig.stdout).toContain('"version":1');
		},
	);

	test("detectInlineMcpConfigSecrets flags inline secrets without returning secret values", () => {
		const findings = detectInlineMcpConfigSecrets({
			remote: {
				transport: "http",
				url: "https://mcp.example.test/rpc",
				oauth: { client_secret: "super-secret-client" },
				headers: {
					Authorization: "Bearer super-secret-token",
					"X-Custom-Mode": "normal",
				},
			},
			local: {
				transport: "stdio",
				command: "node",
				env: {
					GITHUB_TOKEN: "ghp_secretvalue123456",
					NODE_ENV: "development",
				},
			},
		});
		expect(findings).toEqual([
			{ serverId: "remote", field: "oauth.client_secret" },
			{ serverId: "remote", field: "headers", key: "Authorization" },
			{ serverId: "local", field: "env", key: "GITHUB_TOKEN" },
		]);
		expect(JSON.stringify(findings)).not.toContain("super-secret");
		expect(JSON.stringify(findings)).not.toContain("ghp_");
	});
});
