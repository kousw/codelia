import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_VERSION } from "@codelia/config";
import {
	appendPermissionAllowRules,
	loadConfig,
	loadMcpServers,
	removeMcpServerConfig,
	setMcpServerEnabled,
	updateModelConfig,
	upsertMcpServerConfig,
} from "../src/index";

const createTempDir = async (): Promise<string> => {
	return mkdtemp(path.join(os.tmpdir(), "codelia-config-"));
};

const cleanupTempDir = async (dir: string): Promise<void> => {
	await rm(dir, { recursive: true, force: true });
};

describe("@codelia/config-loader", () => {
	test("loadConfig returns null when file is missing", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "missing.json");
			const result = await loadConfig(configPath);
			expect(result).toBeNull();
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("loadConfig returns parsed config when file exists", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await writeFile(
				configPath,
				`${JSON.stringify({
					version: CONFIG_VERSION,
					model: { provider: "openai", name: "gpt-5.2-codex" },
				})}\n`,
				"utf8",
			);

			const result = await loadConfig(configPath);

			expect(result?.version).toBe(CONFIG_VERSION);
			expect(result?.model?.provider).toBe("openai");
			expect(result?.model?.name).toBe("gpt-5.2-codex");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig creates config when missing", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "nested", "config.json");
			const updated = await updateModelConfig(configPath, {
				provider: "openai",
				name: "gpt-5.2-codex",
			});

			expect(updated.model?.name).toBe("gpt-5.2-codex");

			const raw = JSON.parse(await readFile(configPath, "utf8"));
			expect(raw.version).toBe(CONFIG_VERSION);
			expect(raw.model.provider).toBe("openai");
			expect(raw.model.name).toBe("gpt-5.2-codex");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig defaults version when missing", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await writeFile(
				configPath,
				`${JSON.stringify({
					model: { provider: "openai", name: "gpt-5.2-codex" },
				})}\n`,
				"utf8",
			);

			const updated = await updateModelConfig(configPath, {
				name: "gpt-5.2",
			});

			expect(updated.version).toBe(CONFIG_VERSION);
			expect(updated.model?.name).toBe("gpt-5.2");

			const raw = JSON.parse(await readFile(configPath, "utf8"));
			expect(raw.version).toBe(CONFIG_VERSION);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig throws on invalid JSON", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await writeFile(configPath, "{", "utf8");

			await expect(
				updateModelConfig(configPath, { name: "gpt-5.2" }),
			).rejects.toThrow("Failed to parse config.json");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig throws on non-object JSON", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await writeFile(configPath, "[]", "utf8");

			await expect(
				updateModelConfig(configPath, { name: "gpt-5.2" }),
			).rejects.toThrow("config.json must be a JSON object");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig throws on unsupported version", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await writeFile(
				configPath,
				`${JSON.stringify({ version: 2 })}\n`,
				"utf8",
			);

			await expect(
				updateModelConfig(configPath, { name: "gpt-5.2" }),
			).rejects.toThrow("unsupported version");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("updateModelConfig preserves other fields", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			const initial = {
				version: CONFIG_VERSION,
				extra: "keep",
				model: {
					provider: "openai",
					name: "gpt-5.2-codex",
					reasoning: "medium",
				},
			};
			await writeFile(configPath, `${JSON.stringify(initial)}\n`, "utf8");

			const updated = await updateModelConfig(configPath, {
				name: "gpt-5.2",
			});

			expect(updated.model?.name).toBe("gpt-5.2");
			expect(updated.model?.reasoning).toBe("medium");

			const raw = JSON.parse(await readFile(configPath, "utf8"));
			expect(raw.extra).toBe("keep");
			expect(raw.model.name).toBe("gpt-5.2");
			expect(raw.model.reasoning).toBe("medium");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("upsertMcpServerConfig creates and updates mcp server entries", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await upsertMcpServerConfig(configPath, "local", {
				transport: "stdio",
				command: "npx",
			});
			await upsertMcpServerConfig(configPath, "remote", {
				transport: "http",
				url: "https://example.com/mcp",
			});

			const servers = await loadMcpServers(configPath);
			expect(Object.keys(servers).sort()).toEqual(["local", "remote"]);
			expect(servers.local?.transport).toBe("stdio");
			expect(servers.remote?.transport).toBe("http");
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("setMcpServerEnabled toggles enabled flag and returns false when missing", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await upsertMcpServerConfig(configPath, "local", {
				transport: "stdio",
				command: "npx",
			});
			const missing = await setMcpServerEnabled(configPath, "missing", false);
			expect(missing).toBe(false);

			const updated = await setMcpServerEnabled(configPath, "local", false);
			expect(updated).toBe(true);
			const servers = await loadMcpServers(configPath);
			expect(servers.local?.enabled).toBe(false);
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("removeMcpServerConfig removes entries and returns false when missing", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await upsertMcpServerConfig(configPath, "local", {
				transport: "stdio",
				command: "npx",
			});
			const removed = await removeMcpServerConfig(configPath, "local");
			expect(removed).toBe(true);
			const removedMissing = await removeMcpServerConfig(configPath, "local");
			expect(removedMissing).toBe(false);
			const servers = await loadMcpServers(configPath);
			expect(servers).toEqual({});
		} finally {
			await cleanupTempDir(dir);
		}
	});

	test("appendPermissionAllowRules deduplicates existing rules", async () => {
		const dir = await createTempDir();
		try {
			const configPath = path.join(dir, "config.json");
			await appendPermissionAllowRules(configPath, [
				{ tool: "bash", command: "git status" },
				{ tool: "bash", command: "git status" },
				{ tool: "skill_load", skill_name: "repo-review" },
				{ tool: "skill_load", skill_name: "repo-review" },
				{ tool: "skill_load", skill_name: "release-notes" },
			]);

			const loaded = await loadConfig(configPath);
			expect(loaded?.permissions?.allow).toEqual([
				{ tool: "bash", command: "git status" },
				{ tool: "skill_load", skill_name: "repo-review" },
				{ tool: "skill_load", skill_name: "release-notes" },
			]);
		} finally {
			await cleanupTempDir(dir);
		}
	});
});
