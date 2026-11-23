import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removePermissionRules, updateConfigValue } from "../src/index";

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

test("config transactions wait for another process before reading and writing", async () => {
	await writeFile(configPath, '{"version":1}');
	const alias = path.join(dir, "config-link.json");
	if (process.platform !== "win32")
		await symlink(path.basename(configPath), alias);
	const holderPath = path.join(dir, "holder.ts");
	const writerPath = path.join(dir, "writer.ts");
	await writeFile(
		holderPath,
		`
import { readFile, writeFile } from "node:fs/promises";
import { withConfigFileLock } from ${JSON.stringify(path.join(import.meta.dir, "../src/config-file-lock.ts"))};
const file = process.argv[2];
await withConfigFileLock(file, async () => {
	const config = JSON.parse(await readFile(file, "utf8"));
	console.log("read");
	await Bun.stdin.text();
	config.update = { mode: "auto" };
	await writeFile(file, JSON.stringify(config));
});
`,
	);
	await writeFile(
		writerPath,
		`
import { updateConfigValue } from ${JSON.stringify(path.join(import.meta.dir, "../src/index.ts"))};
console.log("ready");
if (!await updateConfigValue(process.argv[2], ["skills", "enabled"], false)) process.exit(1);
`,
	);
	const holder = Bun.spawn([process.execPath, holderPath, configPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	try {
		const holderOutput = holder.stdout.getReader();
		const readSignal = await holderOutput.read();
		holderOutput.releaseLock();
		expect(new TextDecoder().decode(readSignal.value).trim()).toBe("read");
		const writer = Bun.spawn(
			[
				process.execPath,
				writerPath,
				process.platform === "win32" ? configPath : alias,
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		try {
			const writerOutput = writer.stdout.getReader();
			const readySignal = await writerOutput.read();
			writerOutput.releaseLock();
			expect(new TextDecoder().decode(readySignal.value).trim()).toBe("ready");
			const state = await Promise.race([
				writer.exited.then(() => "exited"),
				Bun.sleep(300).then(() => "waiting"),
			]);
			expect(state).toBe("waiting");
			expect(await readRaw()).toEqual({ version: 1 });
			await holder.stdin.end();
			expect(await holder.exited).toBe(0);
			expect(await writer.exited).toBe(0);
			expect(await readRaw()).toEqual({
				version: 1,
				update: { mode: "auto" },
				skills: { enabled: false },
			});
		} finally {
			if (writer.exitCode === null) writer.kill();
			await writer.exited;
		}
	} finally {
		if (holder.exitCode === null) holder.kill();
		await holder.exited;
	}
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

test("concurrent updateConfigValue calls on one file keep every change", async () => {
	await writeFile(configPath, JSON.stringify({ version: 1 }));
	await Promise.all([
		updateConfigValue(configPath, ["search", "mode"], "local"),
		updateConfigValue(configPath, ["skills", "enabled"], false),
		updateConfigValue(configPath, ["subagent", "max_concurrent"], 3),
		updateConfigValue(configPath, ["search", "local", "backend"], "brave"),
	]);
	expect(await readRaw()).toEqual({
		version: 1,
		search: { mode: "local", local: { backend: "brave" } },
		skills: { enabled: false },
		subagent: { max_concurrent: 3 },
	});
});

test("removePermissionRules matches rules in their parsed (listed) form", async () => {
	await writeFile(
		configPath,
		JSON.stringify({
			version: 1,
			permissions: {
				allow: [
					{ tool: "skill_load", skill_name: "My-Skill" },
					{ tool: "shell", command: "", command_glob: "git *" },
					{ tool: "shell", command: "ls" },
				],
			},
		}),
	);
	expect(
		await removePermissionRules(configPath, "allow", {
			tool: "skill_load",
			skill_name: "my-skill",
		}),
	).toBe(1);
	expect(
		await removePermissionRules(configPath, "allow", {
			tool: "shell",
			command_glob: "git *",
		}),
	).toBe(1);
	expect(await readRaw()).toEqual({
		version: 1,
		permissions: { allow: [{ tool: "shell", command: "ls" }] },
	});
});
