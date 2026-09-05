import { describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "@codelia/config";
import type { BaseChatModel, SessionRecord } from "@codelia/core";
import { TaskRegistryStore } from "@codelia/storage";
import { createToolContext } from "../src/rpc/tool";
import { subagentBootstrapSchema } from "../src/subagents/bootstrap";
import { createChildRun } from "../src/subagents/child-runtime";
import type {
	SubagentExecutorFactory,
	SubagentLaunchInput,
} from "../src/subagents/contracts";
import { AgentTreeCoordinator } from "../src/subagents/coordinator";
import { createProcessSubagentFactory } from "../src/subagents/process-executor";
import { redactSubagentJson } from "../src/subagents/output";
import { createSubagentReadTools } from "../src/subagents/read-tools";
import { waitForTaskOrMessage } from "../src/subagents/wait";
import { type TaskExecutionResult, TaskManager } from "../src/tasks";

import { VolatileSessionStateStore } from "../src/volatile-stores";

const setup = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-subagent-"));
	const registry = new TaskRegistryStore(path.join(root, "tasks"));
	const tasks = new TaskManager({ registry });
	return {
		root,
		tasks,
		cleanup: async () => {
			await tasks.shutdown();
			await fs.rm(root, { recursive: true, force: true });
		},
	};
};
const parent = (root: string) => ({
	workspace_root: root,
	model: { provider: "openai", name: "gpt-5" },
	approval_mode: "minimal" as const,
});
const manifest = (root: string): SubagentLaunchInput => {
	const task_id = randomUUID();
	return {
		version: 1,
		task_id,
		workspace_root: root,
		prompt: "complete",
		model: parent(root).model,
		permission: {
			tool_allowlist: ["read", "list_files"],
			workspace_access: "read-only",
			approval_mode: "minimal",
			max_steps: 1,
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
};
const fakeFactory = () => {
	const children: Array<{
		input: SubagentLaunchInput;
		complete: () => void;
		cancelled: boolean;
	}> = [];
	const factory: SubagentExecutorFactory = {
		isAvailable: () => true,
		prepare(input) {
			let resolve!: (value: TaskExecutionResult) => void;
			const wait = new Promise<TaskExecutionResult>((r) => {
				resolve = r;
			});
			const child = {
				input,
				complete: () =>
					resolve({
						state: "completed",
						result: { termination_reason: "normal", summary: "done" },
					}),
				cancelled: false,
			};
			children.push(child);
			return {
				wait,
				async start(control) {
					if (!child.cancelled) {
						await control.running({ child_session_id: input.task_id });
					}
				},
				async cancel() {
					child.cancelled = true;
					resolve({
						state: "cancelled",
						result: { termination_reason: "cancelled" },
					});
				},
			};
		},
	};
	return { factory, children };
};

describe("session-owned subagents", () => {
	for (const maxConcurrent of [undefined, 2]) {
		test(`concurrency ${maxConcurrent ?? "default 8"} spans sessions and releases capacity after completion`, async () => {
			const f = await setup();
			const mock = fakeFactory();
			const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
			const subagent = parseConfig(
				{ version: 1, subagent: { max_concurrent: maxConcurrent } },
				"test",
			).subagent;
			tree.configure({ ...parent(f.root), subagent });
			const spawn = (index: number) =>
				tree.spawn(
					{ kind: "subagent", name: `Scout-${index}`, prompt: "read" },
					{ session_id: index % 2 ? "a" : "b" },
				);
			try {
				const capacity = maxConcurrent ?? 8;
				const admitted = await Promise.all(
					Array.from({ length: capacity }, (_, index) => spawn(index)),
				);
				await expect(spawn(capacity)).rejects.toThrow("task_capacity_exceeded");
				expect(await f.tasks.list()).toHaveLength(capacity);
				expect(
					subagentBootstrapSchema.parse(mock.children[0].input).permission
						.timeout_seconds,
				).toBeUndefined();
				mock.children[0].complete();
				await f.tasks.wait(admitted[0].task_id);
				await spawn(capacity);
				expect(mock.children).toHaveLength(capacity + 1);
				// Lowering capacity preserves admitted work and blocks new admission.
				tree.configure({ ...parent(f.root), subagent: { max_concurrent: 1 } });
				expect(mock.children.every((child) => !child.cancelled)).toBe(true);
				await expect(spawn(capacity + 1)).rejects.toThrow(
					"task_capacity_exceeded",
				);
				expect(() =>
					tree.configure({
						...parent(f.root),
						subagent: { max_concurrent: 0 },
					}),
				).toThrow();
			} finally {
				await f.cleanup();
			}
		});
	}

	test("parent abort preserves the child; completed children allow more than 32 spawns across turns", async () => {
		const f = await setup();
		const mock = fakeFactory();
		const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
		tree.configure({ ...parent(f.root), subagent: { max_concurrent: 1 } });
		try {
			const abort = new AbortController();
			const task = await tree.spawn(
				{ kind: "subagent", name: "Test-scout", prompt: "read" },
				{ session_id: "parent", run_id: "turn-1", signal: abort.signal },
			);
			abort.abort();
			expect(mock.children[0].cancelled).toBe(false);
			expect((await tree.list("parent"))[0].task_id).toBe(task.task_id);
			await expect(tree.requireOwned(task.task_id, "other")).rejects.toThrow(
				"task_not_found",
			);
			await expect(
				tree.spawn(
					{ kind: "subagent", name: "Test-scout", prompt: "more" },
					{ session_id: "parent" },
				),
			).rejects.toThrow("capacity");
			mock.children[0].complete();
			await f.tasks.wait(task.task_id);
			const restarted = new AgentTreeCoordinator(f.tasks, mock.factory);
			restarted.configure({
				...parent(f.root),
				subagent: { max_concurrent: 1 },
			});
			for (let index = 1; index <= 33; index++) {
				const next = await restarted.spawn(
					{ kind: "subagent", name: `Scout-${index}`, prompt: "more" },
					{ session_id: "parent", run_id: "turn-2" },
				);
				mock.children[index].complete();
				await f.tasks.wait(next.task_id);
				expect(next.subagent?.spawn_index).toBe(index + 1);
			}
			expect(await restarted.list("parent")).toHaveLength(34);
		} finally {
			await f.cleanup();
		}
	});

	test("parent wait expiration returns the still-running child without cancelling it", async () => {
		const f = await setup();
		const mock = fakeFactory();
		const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
		tree.configure(parent(f.root));
		const expiry = new AbortController();
		const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(
			expiry.signal,
		);
		try {
			const task = await tree.spawn(
				{ kind: "subagent", name: "Waiting-scout", prompt: "work" },
				{ session_id: "parent" },
			);
			const waiting = waitForTaskOrMessage(tree, "parent", task.task_id);
			expect(timeout).toHaveBeenCalledWith(120000);
			expiry.abort();
			expect(["queued", "running"]).toContain((await waiting).state);
			expect(mock.children[0].cancelled).toBe(false);
			mock.children[0].complete();
			expect((await f.tasks.wait(task.task_id)).state).toBe("completed");
		} finally {
			timeout.mockRestore();
			await f.cleanup();
		}
	});
	test("cancelled admission and unsupported delegation produce no persisted task", async () => {
		const f = await setup();
		const mock = fakeFactory();
		const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
		tree.configure(parent(f.root));
		try {
			await expect(
				tree.spawn(
					{ kind: "subagent", name: "Test-scout", prompt: "read" },
					{ session_id: "parent", signal: AbortSignal.abort() },
				),
			).rejects.toThrow();
			for (const params of [
				{ workspace_access: "read-only", tool_allowlist: ["shell"] },
				{ context_mode: "resume" },
				{ workspace_mode: "worktree" },
				{ max_steps: 0 },
			]) {
				await expect(
					tree.spawn(
						{
							kind: "subagent",
							name: "Test-scout",
							prompt: "read",
							...params,
						} as never,
						{
							session_id: "parent",
						},
					),
				).rejects.toThrow();
			}
			tree.configure({
				...parent(f.root),
				permissions: { deny: [{ tool: "read" }] },
			});
			await expect(
				tree.spawn(
					{ kind: "subagent", name: "Test-scout", prompt: "read" },
					{ session_id: "parent" },
				),
			).rejects.toThrow("denied");
			expect(await f.tasks.list()).toHaveLength(0);
		} finally {
			await f.cleanup();
		}
	});
	test("bulk stop cancels this session only", async () => {
		const f = await setup();
		const mock = fakeFactory();
		const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
		tree.configure(parent(f.root));
		try {
			const a = await tree.spawn(
				{ kind: "subagent", name: "Test-scout", prompt: "a" },
				{ session_id: "a" },
			);
			const b = await tree.spawn(
				{ kind: "subagent", name: "Test-scout", prompt: "b" },
				{ session_id: "b" },
			);
			await tree.cancelAll("a");
			expect((await f.tasks.status(a.task_id))?.state).toBe("cancelled");
			expect((await f.tasks.status(b.task_id))?.state).not.toBe("cancelled");
		} finally {
			await f.cleanup();
		}
	});
});

describe("local child process ownership", () => {
	for (const [prompt, expected] of [
		["complete", "normal"],
		["hang", "timeout"],
	] as const)
		test(`real process ${expected} with durable child identity`, async () => {
			if (process.platform === "win32") return;
			const f = await setup();
			const factory = createProcessSubagentFactory({
				entry: path.join(import.meta.dir, "fixtures/subagent-child.mjs"),
				// Match the shipped Node runtime; Bun's fd stream may report early EOF.
				executable: "node",
				graceMs: 30,
			});
			const tree = new AgentTreeCoordinator(f.tasks, factory);
			tree.configure(parent(f.root));
			try {
				const task = await tree.spawn(
					{
						kind: "subagent",
						name: "Test-scout",
						prompt,
						...(prompt === "hang" ? { timeout_seconds: 1 } : {}),
					},
					{ session_id: "parent" },
				);
				const result = await f.tasks.wait(task.task_id);
				expect(result.result?.termination_reason).toBe(expected);
				expect(result.executor_identity).toBeTruthy();
				expect(result.child_session_id).toBe("child-session");
				expect(result.result?.usage?.total_tokens).toBe(12);
				if (prompt === "complete")
					expect(result.result?.summary).toBe("fixture result");
			} finally {
				await f.cleanup();
			}
		});
	test("cancel before process start launches no process", async () => {
		const f = await setup();
		try {
			const handle = createProcessSubagentFactory().prepare(manifest(f.root));
			await handle.cancel();
			let launched = false;
			await handle.start({
				persistExecutor: async () => {
					launched = true;
				},
				running: async () => {},
			});
			expect(launched).toBe(false);
			expect((await handle.wait).state).toBe("cancelled");
		} finally {
			await f.cleanup();
		}
	});
});

describe("child permissions and terminal result", () => {
	test("reading quoted Bearer text preserves child execution and redacted JSON records", async () => {
		const f = await setup();
		const sessions = new VolatileSessionStateStore();
		const records: SessionRecord[] = [];
		const secret = 'test"credential\\with\nquotes';
		const content =
			'curl -H "Authorization: Bearer ${GH_TOKEN}" \\\n  -H "Accept: application/json"\n' +
			secret;
		try {
			const original = { nested: [content, null, 42, true] };
			const safe = redactSubagentJson(original, [secret]);
			expect(safe).toEqual({
				nested: [
					'curl -H "Authorization: Bearer [redacted]" \\\n  -H "Accept: application/json"\n[redacted]',
					null,
					42,
					true,
				],
			});
			expect(original.nested[0]).toBe(content);
			await fs.writeFile(path.join(f.root, "workflow.yml"), content);
			let calls = 0;
			const launch = manifest(f.root);
			launch.permission.max_steps = 2;
			const child = await createChildRun(
				launch,
				{
					provider: "openai",
					model: "gpt-5",
					async ainvoke() {
						return {
							messages: [
								++calls === 1
									? {
											role: "assistant",
											content: null,
											tool_calls: [
												{
													id: "read-workflow",
													type: "function",
													function: {
														name: "read",
														arguments: JSON.stringify({
															file_path: "workflow.yml",
														}),
													},
												},
											],
										}
									: { role: "assistant", content: "Workflow inspected" },
							],
						};
					},
				},
				{
					sessions,
					secrets: [secret],
					append: async (record) => {
						records.push(record);
					},
				},
			);
			const result = await child.execute(new AbortController().signal);
			expect(result.state).toBe("completed");
			expect(result.result?.summary).toBe("Workflow inspected");
			const saved = await sessions.load(child.session_id);
			for (const retained of [saved?.messages, records]) {
				const serialized = JSON.stringify(retained);
				expect(serialized).toContain("Bearer [redacted]");
				expect(serialized).not.toContain("${GH_TOKEN}");
				expect(serialized).not.toContain(JSON.stringify(secret).slice(1, -1));
			}
		} finally {
			await f.cleanup();
		}
	});

	test("model failures retain a bounded redacted cause in the result and child log", async () => {
		const f = await setup();
		const records: SessionRecord[] = [];
		const secret = "test-only-credential-value";
		try {
			const child = await createChildRun(
				manifest(f.root),
				{
					provider: "openai",
					model: "gpt-5",
					async ainvoke() {
						throw new Error(
							`Missing session key; ${secret}; ${"detail ".repeat(600)}`,
						);
					},
				},
				{
					sessions: new VolatileSessionStateStore(),
					secrets: [secret],
					append: (record) => {
						records.push(record);
					},
				},
			);
			const result = await child.execute(new AbortController().signal);
			expect(result.result?.termination_reason).toBe("execution_error");
			expect(result.failure_message).toContain("Missing session key");
			expect(
				Buffer.byteLength(result.failure_message ?? ""),
			).toBeLessThanOrEqual(2048);
			expect(JSON.stringify([result, records])).not.toContain(secret);
			expect(
				records.some(
					(record) =>
						record.type === "run.end" &&
						record.meta?.failure_message === result.failure_message,
				),
			).toBe(true);
		} finally {
			await f.cleanup();
		}
	});

	test("read-only tools reject external paths and symlinks", async () => {
		const f = await setup();
		try {
			await fs.writeFile(path.join(f.root, "text.txt"), "safe text");
			await fs.symlink(os.tmpdir(), path.join(f.root, "link"));
			const tools = createSubagentReadTools(f.root);
			const read = tools.find((t) => t.name === "read");
			if (!read) throw new Error("Read tool missing");
			expect(
				tools.some((t) => ["shell", "write", "task_spawn"].includes(t.name)),
			).toBe(false);
			await expect(
				read.executeRaw(
					JSON.stringify({ file_path: "../outside" }),
					createToolContext(),
				),
			).rejects.toThrow();
			await expect(
				read.executeRaw(
					JSON.stringify({ file_path: "link" }),
					createToolContext(),
				),
			).rejects.toThrow();
			expect(
				JSON.stringify(
					await read.executeRaw(
						'{"file_path":"text.txt"}',
						createToolContext(),
					),
				),
			).toContain("safe text");
			expect(
				subagentBootstrapSchema.safeParse({
					...manifest(f.root),
					permission: {
						...manifest(f.root).permission,
						tool_allowlist: ["shell"],
					},
				}).success,
			).toBe(false);
		} finally {
			await f.cleanup();
		}
	});
	test("step exhaustion is typed and preserves a separately stored child session", async () => {
		const f = await setup();
		const sessions = new VolatileSessionStateStore();
		const records: SessionRecord[] = [];
		let calls = 0;
		const sessionKeys: Array<string | undefined> = [];
		const llm: BaseChatModel = {
			provider: "openai",
			model: "gpt-5",
			async ainvoke(_input, context) {
				sessionKeys.push(context?.sessionKey);
				calls++;
				return calls === 1
					? {
							messages: [
								{
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "read1",
											type: "function",
											function: { name: "shell", arguments: "{}" },
										},
									],
								},
							],
						}
					: { messages: [{ role: "assistant", content: "partial evidence" }] };
			},
		};
		try {
			const child = await createChildRun(manifest(f.root), llm, {
				sessions,
				append: (r) => {
					records.push(r);
				},
			});
			expect((await sessions.load(child.session_id))?.session_id).toBe(
				child.session_id,
			);
			const result = await child.execute(new AbortController().signal);
			expect(sessionKeys.length).toBeGreaterThan(0);
			expect(sessionKeys.every((key) => key === child.session_id)).toBe(true);
			expect(records.some((record) => record.type === "llm.request")).toBe(
				true,
			);
			expect(result.state).toBe("failed");
			expect(result.result?.termination_reason).toBe("max_steps");
			expect(result.result?.summary).toContain("partial evidence");
			expect(
				(await sessions.load(child.session_id))?.meta?.codelia_subagent,
			).toBeTruthy();
			expect(
				records.some(
					(r) =>
						r.type === "agent.event" &&
						r.event.type === "final" &&
						r.event.termination_reason === "max_steps",
				),
			).toBe(true);
		} finally {
			await f.cleanup();
		}
	});
});

test("oversized child result is redacted, cached, and bounded before parent delivery", async () => {
	const f = await setup();
	let full = "";
	const secret = "test-credential-that-must-not-leak";
	try {
		const child = await createChildRun(
			manifest(f.root),
			{
				provider: "openai",
				model: "gpt-5",
				async ainvoke() {
					return {
						messages: [
							{
								role: "assistant",
								content: `${secret}\n${"あ".repeat(30000)}`,
							},
						],
					};
				},
			},
			{
				secrets: [secret],
				append: () => {},
				sessions: new VolatileSessionStateStore(),
				cache: {
					async save(record) {
						full = record.content;
						return { id: "cached-summary" };
					},
				},
			},
		);
		const result = await child.execute(new AbortController().signal);
		expect(result.state).toBe("completed");
		expect(result.result?.summary_cache_id).toBe("cached-summary");
		expect(Buffer.byteLength(result.result?.summary ?? "")).toBeLessThanOrEqual(
			65536,
		);
		expect(result.result?.summary).toContain("truncated");
		expect(full).not.toContain(secret);
		expect(full).toContain("[redacted]");
	} finally {
		await f.cleanup();
	}
});

test("startup persistence failure stops a process before model work", async () => {
	if (process.platform === "win32") return;
	const f = await setup();
	let recordedPid: number | undefined;
	try {
		const handle = createProcessSubagentFactory({
			entry: path.join(import.meta.dir, "fixtures/subagent-child.mjs"),
			graceMs: 30,
		}).prepare(manifest(f.root));
		await handle.start({
			persistExecutor: async (metadata) => {
				recordedPid = metadata.executor_pid;
				throw new Error("disk unavailable");
			},
			running: async () => {
				throw new Error("must not start a run");
			},
		});
		const result = await handle.wait;
		expect(result.result?.termination_reason).toBe("startup_error");
		expect(recordedPid).toBeTruthy();
		expect(() => process.kill(recordedPid as number, 0)).toThrow();
	} finally {
		await f.cleanup();
	}
});

test("shutdown racing a pending admission cannot leave an unowned child", async () => {
	const f = await setup();
	const mock = fakeFactory();
	const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
	tree.configure(parent(f.root));
	try {
		const admission = tree.spawn(
			{ kind: "subagent", name: "Test-scout", prompt: "work" },
			{ session_id: "owner" },
		);
		const shutdown = f.tasks.shutdown();
		await admission.catch(() => undefined); // Rejected admission or owned cancellation are both valid.
		await shutdown;
		expect(mock.children.every((child) => child.cancelled)).toBe(true);
		expect(
			(await f.tasks.list()).every((task) =>
				["cancelled", "failed"].includes(task.state),
			),
		).toBe(true);
	} finally {
		await f.cleanup();
	}
});

test("bulk-stop fence rejects spawns queued before or during the stop", async () => {
	const f = await setup();
	const mock = fakeFactory();
	const tree = new AgentTreeCoordinator(f.tasks, mock.factory);
	tree.configure(parent(f.root));
	try {
		const queued = tree
			.spawn(
				{ kind: "subagent", name: "Test-scout", prompt: "queued" },
				{ session_id: "owner" },
			)
			.then(
				() => null,
				(error: Error) => error,
			);
		const stop = tree.cancelAll("owner");
		const during = tree
			.spawn(
				{ kind: "subagent", name: "Test-scout", prompt: "during" },
				{ session_id: "owner" },
			)
			.then(
				() => null,
				(error: Error) => error,
			);
		expect((await queued)?.message).toBe("task admission stopped");
		expect((await during)?.message).toBe("task admission stopped");
		await stop;
		expect(await tree.list("owner")).toHaveLength(0);
		const later = await tree.spawn(
			{ kind: "subagent", name: "Test-scout", prompt: "later" },
			{ session_id: "owner" },
		);
		expect(later.state).toBe("queued");
	} finally {
		await f.cleanup();
	}
});

test("dedicated child exits on owner pipe loss before bootstrap without credentials", async () => {
	const { spawn } = await import("node:child_process");
	const child = spawn(
		process.execPath,
		[path.join(import.meta.dir, "../src/subagents/child-entry.ts")],
		{ stdio: ["pipe", "pipe", "pipe", "pipe"] },
	);
	const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
	child.stdout?.resume();
	child.stderr?.resume();
	const close = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	// Owner loss closes the whole channel. Bun extra stdio sockets do not
	// consistently deliver EOF on a writable-only half-close (.end()).
	(child.stdio[3] as import("node:stream").Writable).destroy();
	try {
		const result = await close;
		expect(result.signal).toBe(null);
		expect(result.code).toBe(1);
	} finally {
		clearTimeout(timeout);
	}
});
