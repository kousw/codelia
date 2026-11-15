import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { PermissionRuleEntry, RpcMessage } from "@codelia/protocol";
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

const setEnv = (key: string, value: string | undefined): void => {
	if (!env.has(key)) env.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-permissions-rpc-"));
	workspace = path.join(root, "workspace");
	globalPath = path.join(root, "global.json");
	projectPath = path.join(workspace, ".codelia", "config.json");
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		CODELIA_CONFIG_PATH: globalPath,
		CODELIA_SANDBOX_ROOT: workspace,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	})) {
		setEnv(key, value);
	}
	setEnv("CODELIA_APPROVAL_MODE", undefined);
	await mkdir(path.dirname(projectPath), { recursive: true });
	await writeFile(
		globalPath,
		JSON.stringify({
			version: 1,
			permissions: { deny: [{ tool: "shell", command: "rm" }] },
		}),
	);
	await writeFile(
		projectPath,
		JSON.stringify({
			version: 1,
			search: { mode: "local" },
			permissions: {
				allow: [
					{ tool: "shell", command: "git status" },
					{ tool: "shell", command: "git status" },
					{ tool: "shell", command_glob: "bun test*" },
				],
			},
		}),
	);
	state = new RuntimeState();
	state.runtimeWorkingDir = workspace;
	state.approvalMode = "minimal";
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
			throw new Error("Must not create an agent for permission RPC");
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
	const id = `permissions-${seq}`;
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

const rulesOf = (response: Response): PermissionRuleEntry[] =>
	(response.result?.rules ?? []) as PermissionRuleEntry[];

test("permissions.list returns file rules in order with the resolved approval mode", async () => {
	const response = await request("permissions.list");
	expect(response.result?.paths).toEqual({
		global: globalPath,
		project: projectPath,
	});
	expect(response.result?.approval_mode).toEqual({
		value: "minimal",
		source: "fallback",
		active: "minimal",
	});
	expect(rulesOf(response)).toEqual([
		{
			kind: "deny",
			scope: "global",
			rule: { tool: "shell", command: "rm" },
			removable: true,
		},
		{
			kind: "allow",
			scope: "project",
			rule: { tool: "shell", command: "git status" },
			removable: true,
		},
		{
			kind: "allow",
			scope: "project",
			rule: { tool: "shell", command: "git status" },
			removable: true,
		},
		{
			kind: "allow",
			scope: "project",
			rule: { tool: "shell", command_glob: "bun test*" },
			removable: true,
		},
	]);
});

test("permissions.list can include the read-only system allowlist of the resolved mode", async () => {
	setEnv("CODELIA_APPROVAL_MODE", "trusted");
	const response = await request("permissions.list", { include_system: true });
	expect(response.result?.approval_mode).toMatchObject({
		value: "trusted",
		source: "env",
	});
	const system = rulesOf(response).filter((entry) => entry.scope === "system");
	expect(system.length).toBeGreaterThan(0);
	expect(
		system.every((entry) => !entry.removable && entry.kind === "allow"),
	).toBe(true);
	expect(system.some((entry) => entry.rule.tool === "write")).toBe(true);
	setEnv("CODELIA_APPROVAL_MODE", "bogus");
	const broken = await request("permissions.list");
	expect(broken.result?.approval_mode).toBeNull();
	expect(broken.result?.errors).toEqual([
		{ scope: "approval_mode", message: "approval mode could not be resolved" },
	]);
});

test("permissions.remove deletes every equal entry in one file and drops the cached agent", async () => {
	const response = await request("permissions.remove", {
		scope: "project",
		kind: "allow",
		rule: { tool: "shell", command: "git status" },
	});
	expect(response.result).toEqual({
		scope: "project",
		kind: "allow",
		path: projectPath,
		removed: 2,
	});
	expect(state.agent).toBeNull();
	expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
		version: 1,
		search: { mode: "local" },
		permissions: { allow: [{ tool: "shell", command_glob: "bun test*" }] },
	});

	const deny = await request("permissions.remove", {
		scope: "global",
		kind: "deny",
		rule: { tool: "shell", command: "rm" },
	});
	expect(deny.result?.removed).toBe(1);
	expect(JSON.parse(await readFile(globalPath, "utf8"))).toEqual({
		version: 1,
	});
});

test("permissions.remove without a match, with bad input or while busy writes nothing", async () => {
	const before = await readFile(projectPath, "utf8");
	const agent = state.agent;
	const miss = await request("permissions.remove", {
		scope: "project",
		kind: "deny",
		rule: { tool: "shell", command: "git status" },
	});
	expect(miss.result?.removed).toBe(0);
	// A narrower rule never matches a broader stored one.
	const partial = await request("permissions.remove", {
		scope: "project",
		kind: "allow",
		rule: { tool: "shell" },
	});
	expect(partial.result?.removed).toBe(0);
	expect(state.agent).toBe(agent);
	for (const params of [
		{ scope: "system", kind: "allow", rule: { tool: "read" } },
		{ scope: "project", kind: "ask", rule: { tool: "read" } },
		{ scope: "project", kind: "allow", rule: { command: "git status" } },
		{ scope: "project", kind: "allow", rule: { tool: "shell", extra: "x" } },
		{ scope: "project", kind: "allow", rule: { tool: "shell", command: 1 } },
		{ scope: "project", kind: "allow" },
	]) {
		expect((await request("permissions.remove", params)).error?.code).toBe(
			-32602,
		);
	}
	state.activeRunId = "run-1";
	expect(
		(
			await request("permissions.remove", {
				scope: "project",
				kind: "allow",
				rule: { tool: "shell", command: "git status" },
			})
		).error?.code,
	).toBe(-32001);
	expect(await readFile(projectPath, "utf8")).toBe(before);
});
