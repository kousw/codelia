import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskRegistryStore } from "@codelia/storage";
import {
	type TaskExecutionResult,
	TaskManager,
	TaskManagerError,
	type TaskProcessController,
} from "../src/tasks";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
};

type ProcessState = {
	alivePids: Set<number>;
	groupMembers: Map<number, number[]>;
	signals: string[];
};

const createDeferred = <T>(): Deferred<T> => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const createProcessController = (state: ProcessState): TaskProcessController => ({
	isProcessAlive: async (pid) => state.alivePids.has(pid),
	terminateProcess: async (pid, signal) => {
		state.signals.push(`pid:${pid}:${signal}`);
		state.alivePids.delete(pid);
	},
	terminateProcessGroup: async (pgid, signal) => {
		state.signals.push(`pgid:${pgid}:${signal}`);
		for (const pid of state.groupMembers.get(pgid) ?? []) {
			state.alivePids.delete(pid);
		}
	},
});

const setup = async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codelia-task-manager-"));
	const registry = new TaskRegistryStore(path.join(root, "tasks"));
	const processState: ProcessState = {
		alivePids: new Set<number>(),
		groupMembers: new Map<number, number[]>(),
		signals: [],
	};
	let seq = 0;
	const manager = new TaskManager({
		registry,
		runtimeId: "runtime-test",
		ownerPid: 5000,
		randomId: () => {
			seq += 1;
			return `task-${seq}`;
		},
		sleep: async () => {},
		gracePeriodMs: 0,
		pollIntervalMs: 0,
		processController: createProcessController(processState),
	});
	return {
		registry,
		manager,
		processState,
		registerProcess(pid: number, pgid?: number) {
			processState.alivePids.add(pid);
			if (pgid !== undefined) {
				processState.groupMembers.set(pgid, [
					...(processState.groupMembers.get(pgid) ?? []),
					pid,
				]);
			}
		},
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
};

describe("TaskManager", () => {
	test("spawn -> wait retains terminal result and executor metadata", async () => {
		const env = await setup();
		try {
			const outcome = createDeferred<TaskExecutionResult>();
			env.registerProcess(7001, 7007);
			const task = await env.manager.spawn(
				{ kind: "shell" },
				() => ({
					metadata: { executor_pid: 7001, executor_pgid: 7007 },
					wait: outcome.promise,
				}),
			);

			expect(task.state).toBe("running");
			expect(task.executor_pid).toBe(7001);
			expect(task.executor_pgid).toBe(7007);
			expect(task.started_at).toBeDefined();

			outcome.resolve({
				state: "completed",
				result: { summary: "done", stdout: "ok" },
			});

			const finished = await env.manager.wait(task.task_id);
			expect(finished.state).toBe("completed");
			expect(finished.result).toEqual({ summary: "done", stdout: "ok" });
			expect(await env.manager.result(task.task_id)).toEqual({
				summary: "done",
				stdout: "ok",
			});
		} finally {
			await env.cleanup();
		}
	});

	test("cancel drives local handle to a cancelled terminal task", async () => {
		const env = await setup();
		try {
			const outcome = createDeferred<TaskExecutionResult>();
			let cancelReason: string | undefined;
			const task = await env.manager.spawn(
				{ kind: "shell" },
				() => ({
					metadata: { executor_pid: 7101, executor_pgid: 7107 },
					wait: outcome.promise,
					cancel: async (reason) => {
						cancelReason = reason;
						outcome.resolve({
							state: "cancelled",
							cancellation_reason: reason,
							result: { summary: "stopped" },
						});
					},
				}),
			);

			const cancelled = await env.manager.cancel(task.task_id, {
				reason: "user cancelled",
			});
			expect(cancelReason).toBe("user cancelled");
			expect(cancelled.state).toBe("cancelled");
			expect(cancelled.cancellation_reason).toBe("user cancelled");
			expect(cancelled.result?.summary).toBe("stopped");
		} finally {
			await env.cleanup();
		}
	});

	test("recoverOrphanedTasks terminates executor pids for dead owners", async () => {
		const env = await setup();
		try {
			env.registerProcess(7201, 7207);
			await env.registry.upsert({
				version: 1,
				task_id: "orphan-task",
				kind: "shell",
				workspace_mode: "live_workspace",
				state: "running",
				owner_runtime_id: "dead-runtime",
				owner_pid: 9999,
				executor_pid: 7201,
				executor_pgid: 7207,
				created_at: "2026-03-08T10:00:00.000Z",
				updated_at: "2026-03-08T10:01:00.000Z",
				started_at: "2026-03-08T10:00:10.000Z",
			});

			const recovered = await env.manager.recoverOrphanedTasks();
			expect(recovered).toEqual({ recovered: 1, errors: [] });
			expect(env.processState.signals).toEqual(["pgid:7207:SIGTERM"]);
			expect(env.processState.alivePids.has(7201)).toBe(false);

			const task = await env.registry.get("orphan-task");
			expect(task?.state).toBe("cancelled");
			expect(task?.cleanup_reason).toBe("owner runtime exited unexpectedly");
		} finally {
			await env.cleanup();
		}
	});

	test("shutdown force-kills unfinished owned tasks after grace timeout", async () => {
		const env = await setup();
		try {
			env.registerProcess(7301, 7307);
			const never = createDeferred<TaskExecutionResult>();
			const task = await env.manager.spawn(
				{ kind: "shell" },
				() => ({
					metadata: { executor_pid: 7301, executor_pgid: 7307 },
					wait: never.promise,
					cancel: async () => {},
				}),
			);

			const shutdown = await env.manager.shutdown();
			expect(shutdown).toEqual({ cancelled: 1, errors: [] });
			expect(env.processState.signals).toEqual(["pgid:7307:SIGKILL"]);

			const persisted = await env.registry.get(task.task_id);
			expect(persisted?.state).toBe("cancelled");
			expect(persisted?.cleanup_reason).toBe("cancelled on owner exit");
		} finally {
			await env.cleanup();
		}
	});

	test("spawn rejects unsupported worktree mode without creating a task", async () => {
		const env = await setup();
		try {
			await expect(
				env.manager.spawn({ kind: "shell", workspace_mode: "worktree" }, () => {
					throw new Error("should not start executor");
				}),
			).rejects.toMatchObject({
				code: "unsupported_workspace_mode",
				message: "workspace_mode=worktree is not supported yet.",
			} satisfies Partial<TaskManagerError>);
			expect(await env.manager.list()).toEqual([]);
		} finally {
			await env.cleanup();
		}
	});
});
