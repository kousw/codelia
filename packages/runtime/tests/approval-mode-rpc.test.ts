import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent } from "@codelia/core";
import type { RpcMessage } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

let root: string;
let workspace: string;
let projectKey: string;
let projectsPath: string;
let state: RuntimeState;
let messages: RpcMessage[];
let restoreStdout: () => void;
let handlers: ReturnType<typeof createRuntimeHandlers>;
const env = new Map<string, string | undefined>();
const originalArgv = process.argv;

const setEnv = (key: string, value: string | undefined): void => {
	if (!env.has(key)) env.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
};

const newAgent = (): Agent =>
	new Agent({
		tools: [],
		llm: {
			provider: "openai",
			model: "gpt-6-astra",
			async ainvoke() {
				throw new Error("Must not generate");
			},
		},
	});

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "codelia-approval-mode-rpc-"));
	workspace = path.join(root, "workspace");
	await mkdir(workspace, { recursive: true });
	for (const [key, value] of Object.entries({
		CODELIA_LAYOUT: "xdg",
		CODELIA_CONFIG_PATH: path.join(root, "global.json"),
		CODELIA_SANDBOX_ROOT: workspace,
		XDG_CONFIG_HOME: path.join(root, "config"),
		XDG_STATE_HOME: path.join(root, "state"),
		XDG_DATA_HOME: path.join(root, "data"),
		XDG_CACHE_HOME: path.join(root, "cache"),
	})) {
		setEnv(key, value);
	}
	setEnv("CODELIA_APPROVAL_MODE", undefined);
	projectKey = await realpath(workspace);
	projectsPath = path.join(root, "config", "codelia", "projects.json");
	state = new RuntimeState();
	state.runtimeWorkingDir = workspace;
	state.approvalMode = "minimal";
	state.agent = newAgent();
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
			throw new Error("Must not create an agent for approval_mode.set");
		},
	});
});

afterEach(async () => {
	restoreStdout();
	process.argv = originalArgv;
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
	error?: { code: number; message: string; data?: unknown };
};

let seq = 0;
const request = async (method: string, params?: unknown): Promise<Response> => {
	seq += 1;
	const id = `approval-mode-${seq}`;
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

const readPolicy = async (): Promise<unknown> =>
	JSON.parse(await readFile(projectsPath, "utf8"));

test("initialize advertises approval_mode.set for runtime-owned config", async () => {
	const response = await request("initialize", {
		protocol_version: "0",
		client: { name: "gui", version: "0" },
	});
	expect(
		(response.result?.server_capabilities as Record<string, unknown>)
			?.supports_approval_mode_set,
	).toBe(true);
});

test("approval_mode.set project writes this workspace's entry 0600 and drops the cached agent", async () => {
	const response = await request("approval_mode.set", {
		scope: "project",
		value: "trusted",
	});
	expect(response.result).toEqual({
		scope: "project",
		value: "trusted",
		path: projectsPath,
		changed: true,
		approval_mode: { value: "trusted", source: "project" },
		applies: "next_run",
	});
	expect(await readPolicy()).toEqual({
		version: 1,
		projects: { [projectKey]: { approval_mode: "trusted" } },
	});
	if (process.platform !== "win32") {
		expect((await stat(projectsPath)).mode & 0o777).toBe(0o600);
	}
	expect(state.agent).toBeNull();

	const listed = await request("permissions.list");
	expect(listed.result?.approval_mode).toEqual({
		value: "trusted",
		source: "project",
	});

	// Same value again: nothing is written and a rebuilt agent stays cached.
	const agent = newAgent();
	state.agent = agent;
	const before = await readFile(projectsPath, "utf8");
	const again = await request("approval_mode.set", {
		scope: "project",
		value: "trusted",
	});
	expect(again.result?.changed).toBe(false);
	expect(await readFile(projectsPath, "utf8")).toBe(before);
	expect(state.agent).toBe(agent);
});

test("approval_mode.set default keeps other entries and reports a shadowing project entry", async () => {
	const other = path.join(root, "other-project");
	await mkdir(path.dirname(projectsPath), { recursive: true });
	await writeFile(
		projectsPath,
		JSON.stringify({
			version: 1,
			projects: {
				[other]: { approval_mode: "full-access" },
				[projectKey]: { approval_mode: "minimal" },
			},
		}),
	);
	const response = await request("approval_mode.set", {
		scope: "default",
		value: "trusted",
	});
	expect(response.result).toMatchObject({
		scope: "default",
		value: "trusted",
		changed: true,
		// The project entry still wins for this workspace.
		approval_mode: { value: "minimal", source: "project" },
	});
	expect(await readPolicy()).toEqual({
		version: 1,
		default: { approval_mode: "trusted" },
		projects: {
			[other]: { approval_mode: "full-access" },
			[projectKey]: { approval_mode: "minimal" },
		},
	});
});

test("approval_mode.set refuses when the CLI flag or env decides the mode", async () => {
	setEnv("CODELIA_APPROVAL_MODE", "full-access");
	const byEnv = await request("approval_mode.set", {
		scope: "project",
		value: "minimal",
	});
	expect(byEnv.error).toMatchObject({
		code: -32602,
		data: { source: "env", value: "full-access" },
	});
	setEnv("CODELIA_APPROVAL_MODE", undefined);
	process.argv = [...originalArgv, "--approval-mode=trusted"];
	const byCli = await request("approval_mode.set", {
		scope: "default",
		value: "minimal",
	});
	expect(byCli.error).toMatchObject({
		code: -32602,
		data: { source: "cli", value: "trusted" },
	});
	process.argv = [...originalArgv, "--approval-mode", "bogus"];
	expect(
		(await request("approval_mode.set", { scope: "project", value: "minimal" }))
			.error?.code,
	).toBe(-32602);
	await expect(stat(projectsPath)).rejects.toThrow();
	expect(state.agent).not.toBeNull();
});

test("approval_mode.set with bad input, while busy, or over a broken store writes nothing", async () => {
	for (const params of [
		{ scope: "global", value: "trusted" },
		{ scope: "project", value: "yolo" },
		{ scope: "project", value: 1 },
		{ value: "trusted" },
		{ scope: "project" },
	]) {
		expect((await request("approval_mode.set", params)).error?.code).toBe(
			-32602,
		);
	}
	state.activeRunId = "run-1";
	expect(
		(await request("approval_mode.set", { scope: "project", value: "trusted" }))
			.error?.code,
	).toBe(-32001);
	state.activeRunId = null;
	await expect(stat(projectsPath)).rejects.toThrow();

	await mkdir(path.dirname(projectsPath), { recursive: true });
	await writeFile(projectsPath, "{ not json");
	const broken = await request("approval_mode.set", {
		scope: "project",
		value: "trusted",
	});
	expect(broken.error).toMatchObject({ code: -32000 });
	expect(broken.error?.message).not.toContain("not json");
	expect(await readFile(projectsPath, "utf8")).toBe("{ not json");
	expect(state.agent).not.toBeNull();
});

test("approval_mode.set waits for an in-flight run admission and then reports busy", async () => {
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
	const pending = request("approval_mode.set", {
		scope: "project",
		value: "trusted",
	});
	await Bun.sleep(20);
	releaseAdmission();
	await admission;
	expect((await pending).error?.code).toBe(-32001);
	await expect(stat(projectsPath)).rejects.toThrow();
});

test("approval_mode.set is unavailable for host-owned config", async () => {
	state.effectiveEnvironment = {
		...state.effectiveEnvironment,
		config: { ...state.effectiveEnvironment.config, source: "host" },
	};
	const response = await request("approval_mode.set", {
		scope: "project",
		value: "trusted",
	});
	expect(response.error?.code).toBe(-32602);
	await expect(stat(projectsPath)).rejects.toThrow();
});
