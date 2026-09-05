import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, type BaseChatModel } from "@codelia/core";
import { TaskRegistryStore } from "@codelia/storage";
import { createToolContext } from "../src/rpc/tool";
import { requestUiConfirm } from "../src/rpc/ui-requests";
import { RuntimeState } from "../src/runtime-state";
import { createChildChannel } from "../src/subagents/child-channel";
import { createChildRun } from "../src/subagents/child-runtime";
import type {
	SubagentChannel,
	SubagentExecutorFactory,
	SubagentLaunchInput,
} from "../src/subagents/contracts";
import { AgentTreeCoordinator } from "../src/subagents/coordinator";
import { subagentNameSchema } from "../src/subagents/names";
import { subagentBootstrapSchema } from "../src/subagents/bootstrap";
import type { TaskSpawnParams } from "@codelia/protocol";
import { createProcessSubagentFactory } from "../src/subagents/process-executor";
import { createSubagentReadTools } from "../src/subagents/read-tools";
import { waitForTaskOrMessage } from "../src/subagents/wait";
import { createSubagentWriteTools } from "../src/subagents/write-tools";
import { type TaskExecutionResult, TaskManager } from "../src/tasks";
import { hashUtf8Content } from "../src/tools/content-hash";
import { VolatileSessionStateStore } from "../src/volatile-stores";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test fixture value");
	return value;
}

async function setup(factoryOverride?: SubagentExecutorFactory) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-collab-"));
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(root, "tasks")),
	});
	const channels = new Map<string, SubagentChannel>();
	const launches = new Map<string, SubagentLaunchInput>();
	const factory: SubagentExecutorFactory = factoryOverride ?? {
		isAvailable: () => true,
		prepare(input, channel) {
			if (!channel) throw new Error("missing channel");
			channels.set(input.task_id, channel);
			launches.set(input.task_id, input);
			let resolve!: (result: TaskExecutionResult) => void;
			const wait = new Promise<TaskExecutionResult>((r) => {
				resolve = r;
			});
			return {
				wait,
				async start(control) {
					await control.running({ child_session_id: input.task_id });
				},
				async cancel() {
					resolve({
						state: "cancelled",
						result: { termination_reason: "cancelled" },
					});
				},
			};
		},
	};
	const tree = new AgentTreeCoordinator(tasks, factory);
	tree.configure({
		workspace_root: root,
		model: { provider: "openai", name: "gpt-5" },
		approval_mode: "full-access",
	});
	let spawnIndex = 0;
	const spawn = (owner = "owner", name = `Scout-${++spawnIndex}`) =>
		tree.spawn(
			{ kind: "subagent", name, prompt: "Coordinate changes" },
			{ session_id: owner },
		);
	return {
		root,
		tasks,
		tree,
		channels,
		launches,
		spawn,
		async cleanup() {
			await tasks.shutdown();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}

test("parent, child and sibling mailboxes preserve sender, ownership and durable replay", async () => {
	const f = await setup();
	try {
		const a = await f.spawn(),
			b = await f.spawn(),
			foreign = await f.spawn("foreign");
		const ac = required(f.channels.get(a.task_id));
		const bc = required(f.channels.get(b.task_id));
		const message = (await ac.request("send", {
			recipient: b.task_id,
			content: "I own parser.ts; please handle tests",
		})) as { message_id: string };
		const received = (await bc.request("receive", {})) as Array<{
			sender: string;
			sender_name?: string;
			recipient_name?: string;
			message_id: string;
		}>;
		expect(received[0]).toMatchObject({
			sender: a.task_id,
			sender_name: "Scout-1",
			recipient_name: "Scout-2",
			message_id: message.message_id,
		});
		expect(await bc.request("receive", {})).toEqual([]);
		await expect(
			ac.request("send", { recipient: foreign.task_id, content: "outside" }),
		).rejects.toThrow("not_found");
		await expect(
			ac.request("send", {
				recipient: b.task_id,
				content: "spoof",
				sender: "parent",
				sender_name: "Scout-2",
			}),
		).rejects.toThrow();
		await expect(
			ac.request("send", { recipient: b.task_id, content: "あ".repeat(3000) }),
		).rejects.toThrow("8192");
		await ac.request("send", {
			recipient: "parent",
			content: "May I change shared types?",
		});
		const waiting = await waitForTaskOrMessage(f.tree, "owner", a.task_id);
		expect(["running", "queued"]).toContain(waiting.state);
		expect(
			await f.tree.parentChannel("owner").request("receive", {}),
		).toHaveLength(1);
		await f.tree.parentChannel("owner").request("send", {
			recipient: a.task_id,
			content: "Yes; notify the test owner",
		});
		expect(await ac.request("receive", {})).toHaveLength(1);
		const { AgentMailbox } = await import("../src/subagents/mailbox");
		expect(
			await new AgentMailbox(f.tasks).receive("owner", b.task_id),
		).toHaveLength(1);
		await f.tasks.cancel(b.task_id);
		await expect(
			ac.request("send", { recipient: b.task_id, content: "late" }),
		).rejects.toThrow("finished");
	} finally {
		await f.cleanup();
	}
});

test("message wait aborts without stopping the child or losing a later message", async () => {
	const f = await setup();
	try {
		const a = await f.spawn();
		const abort = new AbortController();
		const wait = required(f.channels.get(a.task_id))
			.request("receive", { wait_seconds: 120 }, abort.signal)
			.catch((e) => e);
		abort.abort();
		expect(await wait).toBeInstanceOf(Error);
		expect((await f.tasks.status(a.task_id))?.state).not.toBe("cancelled");
		await f.tree
			.parentChannel("owner")
			.request("send", { recipient: a.task_id, content: "continue" });
		expect(
			await required(f.channels.get(a.task_id)).request("receive", {}),
		).toHaveLength(1);
	} finally {
		await f.cleanup();
	}
});

test("shared edits reject stale content, create collisions and workspace escapes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-shared-edit-"));
	const tools = [
		...createSubagentReadTools(root),
		...createSubagentWriteTools(root),
	];
	const execute = (name: string, input: unknown) =>
		required(tools.find((tool) => tool.name === name)).executeRaw(
			JSON.stringify(input),
			createToolContext(),
		);
	try {
		const file = path.join(root, "code.ts");
		await fs.writeFile(file, "old\n");
		const edit = {
			file_path: "code.ts",
			old_string: "old",
			new_string: "first",
			expected_hash: hashUtf8Content("old\n"),
		};
		expect(
			JSON.stringify(await execute("read", { file_path: "code.ts" })),
		).toContain(edit.expected_hash);
		await execute("edit", edit);
		await expect(
			execute("edit", { ...edit, new_string: "stale" }),
		).rejects.toThrow("Hash mismatch");
		expect(await fs.readFile(file, "utf8")).toBe("first\n");
		const fresh = {
			file_path: "new.ts",
			content: "created",
			expected_hash: "missing",
		};
		await execute("write", fresh);
		await expect(execute("write", fresh)).rejects.toThrow();
		await expect(
			execute("write", { ...fresh, file_path: "../outside" }),
		).rejects.toThrow("outside");
		await fs.symlink(file, path.join(root, "link.ts"));
		await expect(
			execute("edit", {
				...edit,
				file_path: "link.ts",
				old_string: "first",
				expected_hash: hashUtf8Content("first\n"),
			}),
		).rejects.toThrow("Symbolic");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("running child consumes a redirect before final and writes under parent authorization", async () => {
	const f = await setup();
	try {
		const task = await f.spawn();
		const channel = required(f.channels.get(task.task_id));
		const input = required(f.launches.get(task.task_id));
		let calls = 0;
		const sessions = new VolatileSessionStateStore();
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5",
			async ainvoke(request) {
				calls++;
				if (calls === 1) {
					expect(
						request.messages.some(
							(message) =>
								message.role === "system" &&
								typeof message.content === "string" &&
								message.content.includes('Your display name is "Scout-1"'),
						),
					).toBe(true);
					await f.tree.parentChannel("owner").request("send", {
						recipient: task.task_id,
						content: "Create answer.txt with coordinated output",
					});
					return {
						messages: [{ role: "assistant", content: "Initially done" }],
					};
				}
				if (calls === 2) {
					expect(JSON.stringify(request.messages)).toContain(
						"Create answer.txt",
					);
					return {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "write-1",
										type: "function",
										function: {
											name: "write",
											arguments: JSON.stringify({
												file_path: "answer.txt",
												content: "coordinated",
												expected_hash: "missing",
											}),
										},
									},
								],
							},
						],
					};
				}
				expect(await fs.readFile(path.join(f.root, "answer.txt"), "utf8")).toBe(
					"coordinated",
				);
				return {
					messages: [{ role: "assistant", content: "Created answer.txt" }],
				};
			},
		};
		const child = await createChildRun(input, llm, {
			channel,
			append: () => {},
			sessions,
		});
		const result = await child.execute(new AbortController().signal);
		expect(result.state).toBe("completed");
		expect(calls).toBe(3);
		expect(
			JSON.stringify((await sessions.load(child.session_id))?.messages),
		).toContain("Create answer.txt");
	} finally {
		await f.cleanup();
	}
});

test("delegation snapshot denies mutations, confirms through parent, and keeps read-only cap", async () => {
	const f = await setup();
	try {
		f.tree.configure({
			workspace_root: f.root,
			model: { provider: "openai", name: "gpt-5" },
			approval_mode: "minimal",
		});
		let approvals = 0;
		f.tree.setApproval(async (request) => {
			expect(request.task_name).toBe("Scout-1");
			approvals++;
			return false;
		});
		const a = await f.spawn();
		const channel = required(f.channels.get(a.task_id));
		const write = {
			file_path: "denied.txt",
			content: "x",
			expected_hash: "missing",
		};
		await expect(channel.request("write", write)).rejects.toThrow("denied");
		await expect(fs.stat(path.join(f.root, "denied.txt"))).rejects.toThrow();
		expect(approvals).toBe(1);
		f.tree.configure({
			workspace_root: f.root,
			model: { provider: "openai", name: "gpt-5" },
			approval_mode: "full-access",
			permissions: { deny: [{ tool: "shell" }] },
		});
		const b = await f.tree.spawn(
			{
				kind: "subagent",
				name: "Read-scout",
				prompt: "read",
				workspace_access: "read-only",
			},
			{ session_id: "owner" },
		);
		await expect(
			required(f.channels.get(b.task_id)).request("write", write),
		).rejects.toThrow("denied");
		await expect(
			required(f.channels.get(b.task_id)).request("shell", {
				command: "echo bad",
			}),
		).rejects.toThrow("denied");
		const writable = await f.spawn();
		expect(
			required(f.launches.get(writable.task_id)).permission.workspace_access,
		).toBe("read-write");
		await expect(
			required(f.channels.get(writable.task_id)).request("shell", {
				command: "echo denied",
			}),
		).rejects.toThrow("denied");
		// Later parent configuration cannot widen an already launched child's snapshot.
		await expect(channel.request("write", write)).rejects.toThrow("denied");
		await expect(fs.stat(path.join(f.root, "denied.txt"))).rejects.toThrow();
	} finally {
		await f.cleanup();
	}
});

test("child shell runs in the parent task registry and is cancelled with channel loss", async () => {
	const f = await setup();
	try {
		const a = await f.spawn();
		const channel = required(f.channels.get(a.task_id));
		const result = (await channel.request("shell", {
			command: "printf coordinated",
		})) as { stdout: string };
		expect(result.stdout).toContain("coordinated");
		const abort = new AbortController();
		const pending = channel.request(
			"shell",
			{ command: "sleep 30" },
			abort.signal,
		);
		const end = Date.now() + 2000;
		while (
			(await f.tasks.list()).filter((t) => t.kind === "shell").length < 2 &&
			Date.now() < end
		)
			await Bun.sleep(5);
		abort.abort();
		await pending;
		const shells = (await f.tasks.list()).filter((t) => t.kind === "shell");
		expect(shells).toHaveLength(2);
		expect(
			shells.every((t) => ["completed", "cancelled"].includes(t.state)),
		).toBe(true);
		expect(shells.every((t) => t.parent_tool_call_id === a.task_id)).toBe(true);
	} finally {
		await f.cleanup();
	}
});

test("child request cancellation closes pending response wait", async () => {
	let sent: unknown;
	const bridge = createChildChannel((value) => {
		sent = value;
	});
	const abort = new AbortController();
	const pending = bridge.channel
		.request("receive", { wait_seconds: 120 }, abort.signal)
		.catch((e) => e);
	expect(sent).toBeTruthy();
	abort.abort();
	expect(await pending).toBeInstanceOf(Error);
	bridge.close();
});

test("real child IPC exchanges a question and reply while remaining cancellable", async () => {
	if (process.platform === "win32") return;
	const f = await setup(
		createProcessSubagentFactory({
			entry: path.join(import.meta.dir, "fixtures/subagent-child.mjs"),
			executable: "node",
			graceMs: 30,
		}),
	);
	try {
		const task = await f.tree.spawn(
			{
				kind: "subagent",
				name: "Relay",
				prompt: "conversation",
				timeout_seconds: 5,
			},
			{ session_id: "owner" },
		);
		const questions = await f.tree.mailbox.receive("owner", "parent", 3);
		expect(questions[0]?.content).toBe("Who owns parser.ts?");
		await f.tree.parentChannel("owner").request("send", {
			recipient: task.task_id,
			content: "You own parser.ts",
		});
		const result = await f.tasks.wait(task.task_id);
		expect(result.state).toBe("completed");
		expect(result.result?.summary).toContain("You own parser.ts");
	} finally {
		await f.cleanup();
	}
});

test("repeated peer messages preserve the original iteration budget", async () => {
	let calls = 0;
	const agent = new Agent({
		llm: {
			provider: "openai",
			model: "gpt-5",
			async ainvoke() {
				calls++;
				return { messages: [{ role: "assistant", content: "Current result" }] };
			},
		},
		tools: [],
		maxIterations: 2,
	});
	let reason: string | undefined;
	for await (const event of agent.runStream("Work", {
		pollMessages: async () => ["Peer asks for another adjustment"],
	})) {
		if (event.type === "final") reason = event.termination_reason;
	}
	expect(reason).toBe("max_steps");
	// Two original steps plus the existing bounded final-summary request.
	expect(calls).toBe(3);
});

test("mailbox batches respect escaped frame bytes and retain undelivered messages", async () => {
	const f = await setup();
	try {
		const task = await f.spawn();
		const parent = f.tree.parentChannel("owner");
		for (let i = 0; i < 4; i++)
			await parent.request("send", {
				recipient: task.task_id,
				content: `a${"\u0000".repeat(8191)}`,
			});
		const channel = required(f.channels.get(task.task_id));
		const first = (await channel.request("receive", {})) as unknown[];
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
			128 * 1024,
		);
		expect(first.length).toBeGreaterThan(0);
		const second = (await channel.request("receive", {})) as unknown[];
		expect(first.length + second.length).toBe(4);
	} finally {
		await f.cleanup();
	}
});

test("cancelled child approval releases its pending UI response", async () => {
	const state = new RuntimeState();
	let id = "";
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		const message = JSON.parse(String(chunk));
		id = message.id;
		return true;
	});
	try {
		const abort = new AbortController();
		const pending = requestUiConfirm(
			state,
			{ title: "Child write", message: "a.ts" },
			abort.signal,
		);
		expect(id).not.toBe("");
		abort.abort();
		expect(await pending).toBeNull();
		expect(
			state.resolveUiResponse({ jsonrpc: "2.0", id, result: { ok: true } }),
		).toBe(false);
	} finally {
		output.mockRestore();
	}
});

test("two child processes cannot both overwrite the same observed file through path aliases", async () => {
	const f = await setup(
		createProcessSubagentFactory({
			entry: path.join(import.meta.dir, "fixtures/subagent-child.mjs"),
			executable: "node",
		}),
	);
	let release!: () => void;
	const bothRequested = new Promise<void>((resolve) => {
		release = resolve;
	});
	let approvals = 0;
	f.tree.configure({
		workspace_root: f.root,
		model: { provider: "openai", name: "gpt-5" },
		approval_mode: "minimal",
	});
	f.tree.setApproval(async () => {
		if (++approvals === 2) release();
		await bothRequested;
		return true;
	});
	try {
		await fs.writeFile(path.join(f.root, "shared.txt"), "original");
		await fs.link(
			path.join(f.root, "shared.txt"),
			path.join(f.root, "alias.txt"),
		);
		const records = await Promise.all(
			["first", "second"].map((replacement) =>
				f.tree.spawn(
					{
						kind: "subagent",
						name: `Editor-${replacement}`,
						prompt: `edit:${JSON.stringify({ file_path: replacement === "first" ? "shared.txt" : "alias.txt", old_string: "original", new_string: replacement, expected_hash: hashUtf8Content("original") })}`,
					},
					{ session_id: "owner" },
				),
			),
		);
		const results = await Promise.all(
			records.map((task) => f.tasks.wait(task.task_id)),
		);
		const summaries = results.map((task) => String(task.result?.summary));
		expect(approvals).toBe(2);
		expect(summaries.filter((s) => s.includes("Hash mismatch"))).toHaveLength(
			1,
		);
		expect(summaries.filter((s) => s.includes("content_sha256"))).toHaveLength(
			1,
		);
		const content = await fs.readFile(path.join(f.root, "shared.txt"), "utf8");
		expect(["first", "second"]).toContain(content);
		expect(summaries.some((s) => s.includes(hashUtf8Content(content)))).toBe(
			true,
		);
	} finally {
		release();
		await f.cleanup();
	}
});

test("parent and child confirmations share one queue and cancellation preserves its order", async () => {
	const state = new RuntimeState();
	const sent: Array<{ id: string; params: { title: string } }> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		sent.push(JSON.parse(String(chunk)));
		return true;
	});
	try {
		const parent = requestUiConfirm(state, {
			title: "Parent tool",
			message: "edit",
		});
		const queuedAbort = new AbortController();
		const queued = requestUiConfirm(
			state,
			{ title: "Cancelled child", message: "write" },
			queuedAbort.signal,
		);
		const activeAbort = new AbortController();
		const child = requestUiConfirm(
			state,
			{ title: "Child tool", message: "write" },
			activeAbort.signal,
		);
		const next = requestUiConfirm(state, {
			title: "Next parent tool",
			message: "shell",
		});
		expect(sent.map((m) => m.params.title)).toEqual(["Parent tool"]);
		queuedAbort.abort();
		expect(await queued).toBeNull();
		expect(sent).toHaveLength(1);
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id: required(sent[0]).id,
			result: { ok: true },
		});
		expect(await parent).toEqual({ ok: true });
		await Bun.sleep(0);
		expect(sent.map((m) => m.params.title)).toEqual([
			"Parent tool",
			"Child tool",
		]);
		activeAbort.abort();
		expect(await child).toBeNull();
		await Bun.sleep(0);
		expect(sent.map((m) => m.params.title)).toEqual([
			"Parent tool",
			"Child tool",
			"Next parent tool",
		]);
		expect(
			state.resolveUiResponse({
				jsonrpc: "2.0",
				id: required(sent[1]).id,
				result: { ok: true },
			}),
		).toBe(false);
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id: required(sent[2]).id,
			result: { ok: false, reason: "revise" },
		});
		expect(await next).toEqual({ ok: false, reason: "revise" });
	} finally {
		output.mockRestore();
	}
});

test("agent names survive turns and completion, remain unique per owner, and stay separate from assignments", async () => {
	const f = await setup();
	try {
		const [a, b] = await Promise.all([f.spawn(), f.spawn()]);
		expect([a.subagent?.name, b.subagent?.name]).toEqual([
			"Scout-1",
			"Scout-2",
		]);
		expect(required(f.launches.get(a.task_id)).lineage.name).toBe("Scout-1");
		const named = await f.tree.spawn(
			{
				kind: "subagent",
				prompt: "Implement the API",
				name: "  Kaori  ",
				label: "API implementation",
			},
			{ session_id: "owner" },
		);
		expect(named.subagent?.name).toBe("Kaori");
		expect(named.title).toBe("API implementation");
		await expect(
			f.tree.spawn(
				{ kind: "subagent", prompt: "duplicate", name: "kaori" },
				{ session_id: "owner" },
			),
		).rejects.toThrow("name_in_use");
		await expect(
			f.tree.spawn(
				{ kind: "subagent", prompt: "reserved", name: "Parent" },
				{ session_id: "owner" },
			),
		).rejects.toThrow("reserved");
		await f.tasks.cancel(a.task_id);
		const restored = new AgentTreeCoordinator(f.tasks, f.tree.factory);
		restored.configure({
			workspace_root: f.root,
			model: { provider: "openai", name: "gpt-5" },
			approval_mode: "full-access",
		});
		await expect(
			restored.spawn(
				{ kind: "subagent", name: "scout-1", prompt: "reuse completed name" },
				{ session_id: "owner" },
			),
		).rejects.toThrow("name_in_use");
		const next = await restored.spawn(
			{ kind: "subagent", name: "Velvet Comet", prompt: "next turn" },
			{ session_id: "owner" },
		);
		expect(next.subagent?.name).toBe("Velvet Comet");
		expect((await f.tasks.status(a.task_id))?.subagent?.name).toBe("Scout-1");
		const siblings = (await required(f.channels.get(b.task_id)).request(
			"list",
			{},
		)) as Array<{ name?: string; task_id: string; title?: string }>;
		expect(
			siblings.find((task) => task.task_id === named.task_id),
		).toMatchObject({ name: "Kaori", title: "API implementation" });
		const message = await required(f.channels.get(named.task_id)).request(
			"send",
			{ recipient: "parent", content: "API done" },
		);
		expect(message).toMatchObject({
			sender: named.task_id,
			sender_name: "Kaori",
		});
		expect(await restored.mailbox.receive("owner", "parent")).toMatchObject([
			{ sender_name: "Kaori" },
		]);
	} finally {
		await f.cleanup();
	}
});

// Names are parent input; validate before persisting or launching a child.
test("parent must supply a valid name and concurrent duplicate names admit only one child", async () => {
	const f = await setup();
	try {
		expect(subagentNameSchema.parse("蒼い星")).toBe("蒼い星");
		for (const name of [
			"#bad",
			undefined,
			"   ",
			"Parent",
			"x".repeat(49),
			"bad\nname",
		]) {
			await expect(
				f.tree.spawn(
					{ kind: "subagent", prompt: "work", name },
					{ session_id: "owner" },
				),
			).rejects.toThrow();
		}
		expect(await f.tasks.list()).toHaveLength(0);
		expect(f.launches.size).toBe(0);
		const results = await Promise.allSettled([
			f.spawn("owner", "Cinder Wren"),
			f.spawn("owner", "cinder wren"),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected?.status === "rejected" && rejected.reason.message).toBe(
			"subagent_name_in_use",
		);
		expect(f.launches.size).toBe(1);
		const foreign = await f.spawn("foreign", "Cinder Wren");
		expect(foreign.subagent?.name).toBe("Cinder Wren");
	} finally {
		await f.cleanup();
	}
});

test("model selection prioritizes explicit requests and profiles over the default, then inherits the parent unchanged", async () => {
	const f = await setup();
	const parentModel = {
		provider: "openai",
		name: "parent-model",
		reasoning: "high",
		verbosity: "low",
		fast: true,
		experimental: { openai: { websocket_mode: "on" as const } },
	};
	const profiles = {
		research: {
			description: "Investigation",
			model: {
				provider: "openrouter",
				name: "vendor/unlisted-research",
				reasoning: "low",
			},
		},
		review: { model: { provider: "anthropic", name: "unlisted-review" } },
	};
	const cases: Array<{
		configured: boolean;
		selection: Pick<TaskSpawnParams, "model" | "profile">;
		expected: SubagentLaunchInput["model"];
	}> = [
		{ configured: false, selection: {}, expected: parentModel },
		{ configured: true, selection: {}, expected: profiles.research.model },
		{
			configured: true,
			selection: { profile: "review" },
			expected: profiles.review.model,
		},
		{
			configured: true,
			selection: {
				model: {
					provider: "xai",
					name: "unlisted-chat-model",
					reasoning: "max",
				},
			},
			expected: {
				provider: "xai",
				name: "unlisted-chat-model",
				reasoning: "max",
			},
		},
		{
			configured: true,
			selection: { model: { name: "same-provider-model" } },
			expected: { provider: "openai", name: "same-provider-model" },
		},
	];
	try {
		for (const [index, entry] of cases.entries()) {
			f.tree.configure({
				workspace_root: f.root,
				model: parentModel,
				approval_mode: "full-access",
				subagent: {
					profiles,
					...(entry.configured ? { default_profile: "research" } : {}),
				},
			});
			const task = await f.tree.spawn(
				{
					kind: "subagent",
					name: `Model-${index}`,
					prompt: "work",
					...entry.selection,
				},
				{ session_id: "owner" },
			);
			const launch = required(f.launches.get(task.task_id));
			expect(launch.model).toEqual(entry.expected);
			expect(entry.expected).toEqual(
				subagentBootstrapSchema.parse(launch).model,
			);
			await f.tasks.cancel(task.task_id);
		}
		const launches = f.launches.size;
		for (const selection of [
			{ profile: "missing" },
			{ profile: "toString" },
			{ profile: "review", model: { name: "ambiguous" } },
			{ model: { provider: "unsupported", name: "unknown" } },
		]) {
			await expect(
				f.tree.spawn(
					{ kind: "subagent", name: "Invalid", prompt: "work", ...selection },
					{ session_id: "owner" },
				),
			).rejects.toThrow();
		}
		expect(f.launches.size).toBe(launches);
		expect(parentModel.fast).toBe(true);
		expect(parentModel.name).toBe("parent-model");
	} finally {
		await f.cleanup();
	}
});
