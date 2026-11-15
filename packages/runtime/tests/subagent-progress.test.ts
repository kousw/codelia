import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Agent, BaseChatModel, SessionRecord } from "@codelia/core";
import type { RpcMessage } from "@codelia/protocol";
import type { TaskProgress } from "@codelia/shared-types";
import { TaskRegistryStore } from "@codelia/storage";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";
import { createChildRun } from "../src/subagents/child-runtime";
import type { SubagentLaunchInput } from "../src/subagents/contracts";
import {
	createTaskProgressTracker,
	parseTaskProgress,
} from "../src/subagents/progress";
import { type TaskExecutionResult, TaskManager } from "../src/tasks";
import type { PreparedTaskExecution } from "../src/tasks/prepared";
import { VolatileSessionStateStore } from "../src/volatile-stores";

const fixedNow = () => "2026-11-15T00:00:00.000Z";

const until = async (
	condition: () => boolean | Promise<boolean>,
	label: string,
): Promise<void> => {
	const deadline = Date.now() + 2000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
		await Bun.sleep(5);
	}
};

describe("task progress tracker", () => {
	test("counts model steps and tool calls and keeps only tool names", () => {
		const tracker = createTaskProgressTracker({ maxSteps: 5, now: fixedNow });
		const request = { type: "llm.request" } as SessionRecord;
		expect(
			tracker.onRecord({ type: "llm.response" } as SessionRecord),
		).toBeNull();
		expect(tracker.onRecord(request)).toMatchObject({
			step: 1,
			max_steps: 5,
			phase: "model",
			tool_calls: 0,
		});
		const running = tracker.onEvent({
			type: "tool_call",
			tool: "shell",
			args: { command: "cat secret.txt" },
			tool_call_id: "c1",
		});
		expect(running).toEqual({
			step: 1,
			max_steps: 5,
			phase: "tool",
			tool_calls: 1,
			current_tool: {
				name: "shell",
				tool_call_id: "c1",
				started_at: fixedNow(),
			},
			updated_at: fixedNow(),
		});
		const done = tracker.onEvent({
			type: "tool_result",
			tool: "shell",
			result: "top secret output",
			tool_call_id: "c1",
			is_error: true,
		});
		expect(done).toMatchObject({
			phase: "model",
			last_tool: { name: "shell", status: "error" },
		});
		expect(done).not.toHaveProperty("current_tool");
		expect(JSON.stringify(done)).not.toContain("secret");
		expect(
			tracker.onEvent({ type: "text", content: "x", timestamp: 0 }),
		).toBeNull();
		expect(tracker.onRecord(request)?.step).toBe(2);
		expect(tracker.onEvent({ type: "final", content: "done" })?.phase).toBe(
			"finishing",
		);
	});

	test("parseTaskProgress accepts tracker output and rejects malformed input", () => {
		const tracker = createTaskProgressTracker({ now: fixedNow });
		tracker.onRecord({ type: "llm.request" } as SessionRecord);
		const valid = tracker.onEvent({
			type: "tool_call",
			tool: "read",
			args: {},
			tool_call_id: "c1",
		});
		expect(parseTaskProgress(valid)).toEqual(valid);
		for (const bad of [
			null,
			{ ...valid, step: -1 },
			{ ...valid, phase: "sleeping" },
			{ ...valid, current_tool: { name: "read" } },
			{
				...valid,
				last_tool: { name: "read", status: "maybe", finished_at: "t" },
			},
			{ ...valid, tool_calls: 1.5 },
		]) {
			expect(parseTaskProgress(bad)).toBeNull();
		}
	});
});

test("a child run reports step/tool progress through the activity callback", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-progress-"));
	const task_id = randomUUID();
	const input: SubagentLaunchInput = {
		version: 1,
		task_id,
		workspace_root: root,
		prompt: "list files",
		model: { provider: "openai", name: "gpt-5" },
		permission: {
			tool_allowlist: ["read", "list_files"],
			workspace_access: "read-only",
			approval_mode: "minimal",
			max_steps: 3,
			timeout_seconds: 5,
		},
		lineage: {
			tree_id: "tree",
			node_id: task_id,
			parent_node_id: "root",
			owner_session_id: "owner",
			depth: 1,
			spawn_index: 1,
			context_mode: "fresh",
			effective_policy_id: "policy",
			workspace_lease_id: task_id,
		},
	};
	let calls = 0;
	const llm: BaseChatModel = {
		provider: "openai",
		model: "gpt-5",
		async ainvoke() {
			calls++;
			return calls === 1
				? {
						messages: [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: "ls1",
										type: "function",
										function: { name: "list_files", arguments: "{}" },
									},
								],
							},
						],
					}
				: { messages: [{ role: "assistant", content: "found files" }] };
		},
	};
	const updates: TaskProgress[] = [];
	try {
		const child = await createChildRun(input, llm, {
			sessions: new VolatileSessionStateStore(),
			append: () => {},
			activity: (progress) => {
				updates.push(progress);
			},
		});
		const result = await child.execute(new AbortController().signal);
		expect(result.state).toBe("completed");
		expect(updates.map((update) => update.phase)).toEqual([
			"model",
			"tool",
			"model",
			"model",
			"finishing",
		]);
		expect(updates[1]?.current_tool?.name).toBe("list_files");
		expect(updates[2]?.last_tool?.name).toBe("list_files");
		expect(updates.at(-1)).toMatchObject({
			step: 2,
			max_steps: 3,
			tool_calls: 1,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("subagent progress is exposed on task.list and streamed to opted-in clients", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-progress-rpc-"),
	);
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(root, "tasks")),
	});
	const state = new RuntimeState();
	state.sessionId = "owner-session";
	state.setUiCapabilities({ supports_task_progress: true });
	const messages: Array<RpcMessage & { params?: Record<string, unknown> }> = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		for (const line of String(chunk).split("\n")) {
			if (line.trim()) messages.push(JSON.parse(line));
		}
		return true;
	}) as typeof process.stdout.write;
	const handlers = createRuntimeHandlers({
		state,
		log: () => {},
		getAgent: async () => ({}) as Agent,
		taskManager: tasks,
	});
	const progressNotes = () =>
		messages.filter(
			(message) => "method" in message && message.method === "task.progress",
		);
	let finish!: (result: TaskExecutionResult) => void;
	const step = (n: number): TaskProgress => ({
		step: n,
		phase: "model",
		tool_calls: n - 1,
		updated_at: `2026-11-15T00:00:0${n}.000Z`,
	});
	let control!: Parameters<PreparedTaskExecution["start"]>[0];
	const handle: PreparedTaskExecution = {
		wait: new Promise((resolve) => {
			finish = resolve;
		}),
		cancel: async () => {},
		start: async (value) => {
			control = value;
			await value.running({});
		},
	};
	try {
		const task = await tasks.spawnPrepared(
			{
				task_id: "scout-task",
				kind: "subagent",
				title: "scout",
				workspace_mode: "live_workspace",
				working_directory: root,
				parent_session_id: "owner-session",
				subagent: {
					name: "scout",
					tree_id: "tree",
					node_id: "scout-task",
					parent_node_id: "root",
					owner_session_id: "owner-session",
					depth: 1,
					spawn_index: 1,
					context_mode: "fresh",
					effective_policy_id: "policy",
					workspace_lease_id: "lease",
				},
			},
			handle,
		);
		await until(
			async () =>
				Boolean(control) &&
				(await tasks.status(task.task_id))?.state === "running",
			"task running",
		);
		control.progress?.(step(1));
		control.progress?.(step(2));
		control.progress?.(step(3));
		await until(() => tasks.getProgress(task.task_id)?.step === 3, "step 3");
		// Coalesced: the burst ends with exactly one trailing note carrying step 3.
		await Bun.sleep(350);
		const running = progressNotes().filter(
			(note) => note.params?.state === "running",
		);
		expect(running.at(-1)?.params).toMatchObject({
			task_id: task.task_id,
			name: "scout",
			state: "running",
			progress: step(3),
		});
		expect(
			running.filter((note) => note.params?.progress !== undefined).length,
		).toBeLessThan(3);

		handlers.processMessage({
			jsonrpc: "2.0",
			id: "list",
			method: "task.list",
			params: {},
		});
		await until(
			() =>
				messages.some((message) => "id" in message && message.id === "list"),
			"task.list",
		);
		const list = messages.find(
			(message) => "id" in message && message.id === "list",
		) as { result?: { tasks?: Array<Record<string, unknown>> } };
		expect(list.result?.tasks?.[0]?.progress).toEqual(step(3));

		finish({ state: "completed", result: { summary: "done" } });
		await until(
			() => progressNotes().some((note) => note.params?.state === "completed"),
			"completed note",
		);
		// Progress after a terminal state is ignored.
		control.progress?.(step(4));
		await Bun.sleep(20);
		expect(tasks.getProgress(task.task_id)?.step).toBe(3);
	} finally {
		process.stdout.write = write;
		await tasks.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("clients without the opt-in receive no task.progress notifications", async () => {
	const root = await fs.mkdtemp(
		path.join(os.tmpdir(), "codelia-progress-off-"),
	);
	const tasks = new TaskManager({
		registry: new TaskRegistryStore(path.join(root, "tasks")),
	});
	const state = new RuntimeState();
	const sent: string[] = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		sent.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		createRuntimeHandlers({
			state,
			log: () => {},
			getAgent: async () => ({}) as Agent,
			taskManager: tasks,
		});
		let finish!: (result: TaskExecutionResult) => void;
		const task = await tasks.spawnPrepared(
			{
				kind: "subagent",
				title: "quiet",
				workspace_mode: "live_workspace",
				working_directory: root,
			},
			{
				wait: new Promise((resolve) => {
					finish = resolve;
				}),
				cancel: async () => {},
				start: async (control) => {
					await control.running({});
					control.progress?.({
						step: 1,
						phase: "model",
						tool_calls: 0,
						updated_at: fixedNow(),
					});
				},
			},
		);
		const deadline = Date.now() + 2000;
		while (!tasks.getProgress(task.task_id)) {
			if (Date.now() > deadline) throw new Error("progress not recorded");
			await Bun.sleep(5);
		}
		finish({ state: "completed" });
		await Bun.sleep(50);
		expect(sent.join("")).not.toContain("task.progress");
	} finally {
		process.stdout.write = write;
		await tasks.shutdown();
		await fs.rm(root, { recursive: true, force: true });
	}
});
