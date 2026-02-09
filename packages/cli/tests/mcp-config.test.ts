import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
