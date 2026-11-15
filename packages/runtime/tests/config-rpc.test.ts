import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { ConfigEntry, RpcMessage } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

let root: string;
let workspace: string;
let globalPath: string;
let projectPath: string;
let state: RuntimeState;
let messages: RpcMessage[];
let restoreStdout: () => void;
let handlers: ReturnType<typeof createRuntimeHandlers>;
const env = new Map<string, string | undefined>();

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-config-rpc-"));
	workspace = path.join(root, "workspace");
	globalPath = path.join(root, "global.json");
	projectPath = path.join(workspace, ".codelia", "config.json");
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		CODELIA_CONFIG_PATH: globalPath,
		// The default workspace root (and so the project config dir) follows the sandbox root.
		CODELIA_SANDBOX_ROOT: workspace,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	})) {
		env.set(key, process.env[key]);
		process.env[key] = value;
	}
	await mkdir(path.dirname(projectPath), { recursive: true });
	await writeFile(
		globalPath,
		JSON.stringify({
			version: 1,
			model: { provider: "anthropic", name: "claude-opus-5" },
			search: { mode: "native" },
			subagent: { max_concurrent: 4 },
		}),
	);
	await writeFile(
		projectPath,
		JSON.stringify({
			version: 1,
			search: { mode: "local" },
			permissions: { allow: [{ tool: "shell", command: "git status" }] },
		}),
	);
	state = new RuntimeState();
	state.runtimeWorkingDir = workspace;
	state.agent = new Agent({
		tools: [],
		llm: {
			provider: "openai",
			model: "gpt-6-astra",
			async ainvoke() {
				throw new Error("Must not generate");
			},
		},
	});
	messages = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		messages.push(JSON.parse(String(chunk)) as RpcMessage);
		return true;
	}) as typeof process.stdout.write;
	restoreStdout = () => {
		process.stdout.write = write;
	};
	handlers = createRuntimeHandlers({
		state,
		log: () => {},
		getAgent: async () => {
			throw new Error("Must not create an agent for config RPC");
		},
	});
});

afterEach(async () => {
	restoreStdout();
	for (const [key, value] of env) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	env.clear();
	await rm(root, { recursive: true, force: true });
});

type Response = {
	id?: string;
	method?: string;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

let seq = 0;
const request = async (method: string, params?: unknown): Promise<Response> => {
	seq += 1;
	const id = `config-${seq}`;
	handlers.processMessage({ jsonrpc: "2.0", id, method, params });
	const deadline = Date.now() + 2000;
	for (;;) {
		const found = (messages as Response[]).find(
			(message) => message.id === id && !message.method,
		);
		if (found) return found;
		if (Date.now() > deadline) throw new Error(`${method} did not settle`);
		await Bun.sleep(1);
	}
};

const entriesOf = (response: Response): Map<string, ConfigEntry> =>
	new Map(
		((response.result?.entries ?? []) as ConfigEntry[]).map((entry) => [
			entry.key,
			entry,
		]),
	);

const readJson = async (file: string): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

test("config.get reports effective values with their origin layer", async () => {
	const response = await request("config.get");
	expect(response.result?.paths).toEqual({
		global: globalPath,
		project: projectPath,
	});
	const entries = entriesOf(response);
	expect(entries.get("search.mode")).toMatchObject({
		value: "local",
		source: "project",
		global: "native",
		project: "local",
		type: "enum",
		enum: ["auto", "native", "local"],
		default_scope: "project",
		writable: true,
	});
	expect(entries.get("subagent.max_concurrent")).toMatchObject({
		value: 4,
		source: "global",
		global: 4,
		min: 1,
		max: 16,
		default_scope: "global",
	});
	expect(entries.get("skills.enabled")).toMatchObject({
		value: true,
		source: "default",
	});
	expect(entries.get("skills.enabled")).not.toHaveProperty("global");
	expect(entries.get("model.name")).toMatchObject({
		value: "claude-opus-5",
		source: "global",
		writable: false,
		write_via: "model.set",
	});
	// Permission rules, providers and MCP servers are never exposed here.
	expect(
		[...entries.keys()].some((key) =>
			/^(permissions|providers|mcp)\./.test(key),
		),
	).toBe(false);

	const scoped = await request("config.get", { keys: ["search.mode"] });
	expect(scoped.result?.entries).toHaveLength(1);
	expect(
		(await request("config.get", { keys: ["permissions.allow"] })).error?.code,
	).toBe(-32602);
});

test("config.get reports a broken layer without echoing its contents", async () => {
	await writeFile(projectPath, "{ not json SECRET_TEXT");
	const response = await request("config.get", { keys: ["search.mode"] });
	expect(response.result?.errors).toEqual([
		{ scope: "project", message: "project config could not be parsed" },
	]);
	expect(JSON.stringify(response)).not.toContain("SECRET_TEXT");
	expect(entriesOf(response).get("search.mode")).toMatchObject({
		value: "native",
		source: "global",
	});
});

test("config.set writes the requested scope, preserves other fields and drops the cached agent", async () => {
	const response = await request("config.set", {
		scope: "global",
		key: "search.mode",
		value: "auto",
	});
	expect(response.result).toMatchObject({
		key: "search.mode",
		scope: "global",
		path: globalPath,
		applies: "next_run",
		entry: { value: "local", source: "project", global: "auto" },
	});
	expect(state.agent).toBeNull();
	expect(await readJson(globalPath)).toEqual({
		version: 1,
		model: { provider: "anthropic", name: "claude-opus-5" },
		search: { mode: "auto" },
		subagent: { max_concurrent: 4 },
	});

	const unset = await request("config.set", {
		scope: "project",
		key: "search.mode",
		unset: true,
	});
	expect(unset.result?.entry).toMatchObject({
		value: "auto",
		source: "global",
	});
	expect(await readJson(projectPath)).toEqual({
		version: 1,
		permissions: { allow: [{ tool: "shell", command: "git status" }] },
	});
});

test("config.set rejects invalid requests and busy runtimes without writing", async () => {
	const before = {
		global: await readFile(globalPath, "utf8"),
		project: await readFile(projectPath, "utf8"),
	};
	for (const params of [
		{ scope: "global", key: "search.mode", value: "web" },
		{ scope: "global", key: "subagent.max_concurrent", value: 17 },
		{ scope: "global", key: "subagent.max_concurrent", value: 2.5 },
		{ scope: "global", key: "skills.enabled", value: "false" },
		{ scope: "global", key: "model.name", value: "gpt-6-astra" },
		{ scope: "global", key: "permissions.allow", value: "x" },
		{ scope: "global", key: "mcp.servers", value: "x" },
		{ scope: "both", key: "search.mode", value: "auto" },
		{ scope: "global", key: "search.mode" },
		{ scope: "global", key: "search.mode", value: "auto", unset: true },
	]) {
		const response = await request("config.set", params);
		expect(response.error?.code).toBe(-32602);
	}
	const viaModelSet = await request("config.set", {
		scope: "global",
		key: "model.name",
		value: "x",
	});
	expect(viaModelSet.error?.message).toContain("model.set");
	state.activeRunId = "run-1";
	expect(
		(
			await request("config.set", {
				scope: "global",
				key: "search.mode",
				value: "auto",
			})
		).error?.code,
	).toBe(-32001);
	expect(await readFile(globalPath, "utf8")).toBe(before.global);
	expect(await readFile(projectPath, "utf8")).toBe(before.project);
	expect(state.agent).not.toBeNull();
});

test("initialize advertises config read/write for runtime-owned config", async () => {
	const response = await request("initialize", {
		protocol_version: "0",
		client: { name: "gui", version: "0" },
	});
	expect(
		(response.result?.server_capabilities as Record<string, unknown>)
			?.supports_config_rw,
	).toBe(true);
});

test("config.set waits for an in-flight run admission and then reports busy", async () => {
	const before = await readFile(globalPath, "utf8");
	let releaseAdmission!: () => void;
	const admission = state.withAdmissionLock(
		() =>
			new Promise<void>((resolve) => {
				releaseAdmission = () => {
					state.activeRunId = "run-admitted";
					resolve();
				};
			}),
	);
	const pending = request("config.set", {
		scope: "global",
		key: "search.mode",
		value: "auto",
	});
	await Bun.sleep(20);
	releaseAdmission();
	await admission;
	expect((await pending).error?.code).toBe(-32001);
	expect(await readFile(globalPath, "utf8")).toBe(before);
	expect(state.agent).not.toBeNull();
});
