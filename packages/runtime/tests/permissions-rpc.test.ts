import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Agent, defineTool, type ToolContext } from "@codelia/core";
import type {
	PermissionRuleEntry,
	ProjectAllowTrust,
	RpcMessage,
} from "@codelia/protocol";
import { ProjectsPolicyStore } from "@codelia/storage";
import { z } from "zod";
import { resolveLocalPermissionAllows } from "../src/local-permission-allows";
import { createRuntimeToolApproval } from "../src/permissions/tool-approval";
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

test.skipIf(!process.geteuid)(
	"Remember only this builtin across agents; list and revoke it without trusting shared config",
	async () => {
		let confirmations = 0;
		let executions = 0;
		let stale = false;
		state.setRuntimeEnvironment({
			adapters: {
				approvalService: {
					confirm: async ({ requestId, choices }) => {
						confirmations++;
						expect(choices).toContain("save_project");
						expect(choices).not.toContain("save_session");
						if (stale)
							await writeFile(projectPath, JSON.stringify({ version: 1 }));
						return { requestId, choice: "save_project" };
					},
				},
			},
		});
		const tool = defineTool({
			name: "webfetch",
			description: "Count approved requests",
			input: z.object({}),
			execute: () => ++executions,
		});
		const context: ToolContext = {
			deps: {},
			resolve: async (key) => key.create(),
		};
		const invoke = (runtime = state) =>
			createRuntimeToolApproval({
				state: runtime,
				builtinNames: new Set(["webfetch"]),
			})
				.wrap(tool, "builtin")
				.executeRaw("{}", context);
		const sharedBefore = await readFile(projectPath, "utf8");
		await invoke();
		const reopened = new RuntimeState();
		reopened.runtimeWorkingDir = workspace;
		await invoke(reopened);
		expect([confirmations, executions]).toEqual([1, 2]);
		let result = (await request("permissions.list")).result;
		expect(result?.remembered_tools).toEqual([{ tool: "webfetch" }]);
		expect(result?.project_allow_trust).toMatchObject({ trusted: false });
		expect(await readFile(projectPath, "utf8")).toBe(sharedBefore);
		state.activeRunId = "running";
		const busy = await request("permissions.remove", {
			scope: "project",
			remembered_tool: "webfetch",
		});
		expect(busy.error?.message).toBe("runtime busy");
		state.activeRunId = null;
		const extra = await request("permissions.remove", {
			scope: "project",
			remembered_tool: "webfetch",
			future_flag: true,
		});
		expect(extra.error?.code).toBe(-32602);
		const removed = await request("permissions.remove", {
			scope: "project",
			remembered_tool: "webfetch",
		});
		expect(removed.result).toEqual({
			scope: "project",
			remembered_tool: "webfetch",
			removed: 1,
		});
		await expect(invoke(reopened)).rejects.toThrow("confirmation_required");
		result = (await request("permissions.list")).result;
		expect(result?.remembered_tools).toBeUndefined();
		stale = true;
		await expect(invoke()).rejects.toThrow("approval_expired");
		expect([confirmations, executions]).toEqual([2, 2]);
		stale = false;
		const write = spyOn(
			ProjectsPolicyStore.prototype,
			"updateRememberedTool",
		).mockRejectedValueOnce(new Error("write failed"));
		try {
			await expect(invoke()).rejects.toThrow("project_tool_rule_save_failed");
			expect(executions).toBe(2);
		} finally {
			write.mockRestore();
		}
		expect(
			(await request("permissions.list")).result?.remembered_tools,
		).toBeUndefined();
	},
);

test("permissions.list returns file rules in order with the effective sandbox mode", async () => {
	const response = await request("permissions.list");
	expect(response.result?.paths).toEqual({
		global: globalPath,
		project: projectPath,
	});
	expect(response.result?.approval_mode).toBeNull();
	expect(response.result?.sandbox_mode).toEqual({
		value: "workspace-write",
		source: "fallback",
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

test("permissions.list exposes system tool rules independently of legacy mode values", async () => {
	state.sandboxMode = {
		value: "workspace-write",
		source: "env",
		legacy: "trusted",
	};
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
	expect(system.some((entry) => entry.rule.tool === "write")).toBe(false);
	expect(system.some((entry) => entry.rule.tool === "read")).toBe(true);
	expect(response.result?.sandbox_mode).toEqual(state.sandboxMode);
	expect(response.result?.errors).toBeUndefined();
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

test.each([null, 123])(
	"permissions.remove rejects mixed selectors with remembered_tool=%s",
	async (remembered_tool) => {
		const before = await readFile(projectPath, "utf8");
		const response = await request("permissions.remove", {
			remembered_tool,
			scope: "project",
			kind: "allow",
			rule: { tool: "shell", command: "git status" },
		});
		expect(response.error?.code).toBe(-32602);
		expect(await readFile(projectPath, "utf8")).toBe(before);
	},
);

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

test.skipIf(typeof process.geteuid !== "function")(
	"project allow trust requires the reviewed workspace and revision, is idle-only and revocable",
	async () => {
		const list = async () =>
			(await request("permissions.list")).result
				?.project_allow_trust as ProjectAllowTrust;
		const initial = await list();
		expect(initial.workspace).toBe(await realpath(workspace));
		expect(initial.trusted).toBe(false);
		expect(initial.rules).toContainEqual({
			tool: "shell",
			command: "git status",
		});
		const params = {
			workspace: initial.workspace,
			expected_revision: initial.revision,
			trusted: true,
		};
		expect(
			(
				await request("permissions.projectTrust.set", {
					...params,
					workspace: root,
				})
			).error?.code,
		).toBe(-32602);
		state.activeRunId = "active";
		expect(
			(await request("permissions.projectTrust.set", params)).error?.code,
		).toBe(-32001);
		state.activeRunId = null;
		await writeFile(
			projectPath,
			JSON.stringify({
				version: 1,
				permissions: { allow: [{ tool: "shell", command: "cargo test" }] },
			}),
		);
		expect(
			(await request("permissions.projectTrust.set", params)).error?.message,
		).toContain("Review it again");
		const pending = await list();
		expect(pending.trusted).toBe(false);
		const update = (snapshot: ProjectAllowTrust, trusted: boolean) =>
			request("permissions.projectTrust.set", {
				workspace: snapshot.workspace,
				expected_revision: snapshot.revision,
				trusted,
			});
		expect((await update(pending, true)).result).toEqual({
			workspace: initial.workspace,
			trusted: true,
		});
		expect(state.agent).toBeNull();
		const active = await list();
		expect(active.trusted).toBe(true);
		expect((await update(active, false)).result?.trusted).toBe(false);
		expect((await list()).trusted).toBe(false);
	},
);

test("permissions.list and permissions.remove deduplicate rules and require global scope when project shares global config", async () => {
	setEnv("CODELIA_CONFIG_PATH", projectPath);
	await writeFile(
		projectPath,
		JSON.stringify({
			version: 1,
			permissions: {
				allow: [{ tool: "shell", command: "git status" }],
				deny: [{ tool: "shell", command: "rm" }],
			},
		}),
	);

	const listed = await request("permissions.list");
	expect(listed.result?.paths).toEqual({
		global: projectPath,
		project: null,
	});
	expect(rulesOf(listed)).toEqual([
		{
			kind: "allow",
			scope: "global",
			rule: { tool: "shell", command: "git status" },
			removable: true,
		},
		{
			kind: "deny",
			scope: "global",
			rule: { tool: "shell", command: "rm" },
			removable: true,
		},
	]);

	const before = await readFile(projectPath, "utf8");
	const projectRemove = await request("permissions.remove", {
		scope: "project",
		kind: "allow",
		rule: { tool: "shell", command: "git status" },
	});
	expect(projectRemove.error?.code).toBe(-32602);
	expect(projectRemove.error?.message).toContain(
		"shares the global config file",
	);
	expect(await readFile(projectPath, "utf8")).toBe(before);

	const globalRemove = await request("permissions.remove", {
		scope: "global",
		kind: "allow",
		rule: { tool: "shell", command: "git status" },
	});
	expect(globalRemove.error).toBeUndefined();
	expect(globalRemove.result).toMatchObject({
		scope: "global",
		kind: "allow",
		path: projectPath,
		removed: 1,
	});
});

test.skipIf(typeof process.geteuid !== "function")(
	"explicitly trusted project allows remain active when CODELIA_CONFIG_PATH points at the checkout config",
	async () => {
		setEnv("CODELIA_CONFIG_PATH", projectPath);
		await writeFile(
			projectPath,
			JSON.stringify({
				version: 1,
				permissions: {
					allow: [{ tool: "shell", command: "cargo test" }],
				},
			}),
		);
		const listed = await request("permissions.list");
		const trust = listed.result?.project_allow_trust as ProjectAllowTrust;
		expect(trust.trusted).toBe(false);
		expect(trust.rules).toEqual([{ tool: "shell", command: "cargo test" }]);

		const trusted = await request("permissions.projectTrust.set", {
			workspace: trust.workspace,
			expected_revision: trust.revision,
			trusted: true,
		});
		expect(trusted.error).toBeUndefined();
		expect(trusted.result?.trusted).toBe(true);

		const effectiveAllows = await resolveLocalPermissionAllows(
			state,
			workspace,
		);
		expect(effectiveAllows).toContainEqual({
			tool: "shell",
			command: "cargo test",
		});
	},
);
