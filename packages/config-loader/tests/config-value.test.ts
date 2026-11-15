import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { updateConfigValue } from "../src/index";

let dir: string;
let configPath: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "codelia-config-value-"));
	configPath = path.join(dir, "config.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const readRaw = async (): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;

test("updateConfigValue sets nested leaves and preserves unrelated raw fields", async () => {
	await writeFile(
		configPath,
		JSON.stringify({
			version: 1,
			search: { native: { providers: ["openai"] } },
			custom_note: "kept",
		}),
	);
	expect(
		await updateConfigValue(
			configPath,
			["search", "native", "search_context_size"],
			"high",
		),
	).toBe(true);
	expect(
		await updateConfigValue(configPath, ["skills", "enabled"], false),
	).toBe(true);
	expect(await readRaw()).toEqual({
		version: 1,
		search: { native: { providers: ["openai"], search_context_size: "high" } },
		custom_note: "kept",
		skills: { enabled: false },
	});
});

test("updateConfigValue unsets a leaf, prunes empty parents and skips missing keys", async () => {
	await writeFile(
		configPath,
		JSON.stringify({
			version: 1,
			experimental: { openai: { websocket_mode: "on" } },
			search: { mode: "local", local: { backend: "brave" } },
		}),
	);
	expect(
		await updateConfigValue(
			configPath,
			["experimental", "openai", "websocket_mode"],
			undefined,
		),
	).toBe(true);
	expect(
		await updateConfigValue(
			configPath,
			["search", "local", "backend"],
			undefined,
		),
	).toBe(true);
	expect(await readRaw()).toEqual({ version: 1, search: { mode: "local" } });
	const before = await readFile(configPath, "utf8");
	expect(
		await updateConfigValue(configPath, ["skills", "enabled"], undefined),
	).toBe(false);
	expect(await readFile(configPath, "utf8")).toBe(before);
});

test("updateConfigValue refuses to replace a non-object parent and creates missing files", async () => {
	await writeFile(configPath, JSON.stringify({ version: 1, search: "auto" }));
	await expect(
		updateConfigValue(configPath, ["search", "mode"], "local"),
	).rejects.toThrow("search must be an object");
	const fresh = path.join(dir, "nested", "config.json");
	expect(
		await updateConfigValue(fresh, ["subagent", "max_concurrent"], 4),
	).toBe(true);
	expect(JSON.parse(await readFile(fresh, "utf8"))).toEqual({
		version: 1,
		subagent: { max_concurrent: 4 },
	});
});
