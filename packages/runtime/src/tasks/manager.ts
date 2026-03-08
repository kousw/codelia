import crypto from "node:crypto";
import {
	TaskRegistryStore,
	type TaskRecord,
	type TaskResult,
} from "@codelia/storage";
import {
	defaultTaskProcessController,
	type TaskProcessController,
	type TaskProcessSignal,
} from "./process-control";
import {
	isTerminalTaskState,
	type TaskExecutionHandle,
	type TaskExecutionMetadata,
	type TaskExecutionOutputStream,
	type TaskExecutionResult,
	type TaskExecutionStartContext,
	type TaskSpawnInput,
} from "./types";

const DEFAULT_POLL_INTERVAL_MS = 50;
const DEFAULT_GRACE_PERIOD_MS = 2_000;
const OWNER_EXIT_REASON = "owner runtime exited unexpectedly";
const OWNER_SHUTDOWN_REASON = "cancelled on owner exit";

const nowIso = (): string => new Date().toISOString();

const sleepDefault = async (ms: number): Promise<void> => {
	await new Promise((resolve) => setTimeout(resolve, ms));
};

const toErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isErrnoCode = (error: unknown, code: string): boolean =>
	error instanceof Error && "code" in error && error.code === code;

const toTaskResult = (
	current: TaskRecord,
	outcome?: TaskExecutionResult,
): TaskResult | undefined => {
	if (outcome?.result) {
		return {
			...current.result,
			...outcome.result,
		};
	}
	return current.result;
};

const abortedError = (): Error => new Error("task wait aborted");

const withAbort = async <T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return promise;
	if (signal.aborted) throw abortedError();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(abortedError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

export class TaskManagerError extends Error {
	readonly code:
		| "task_not_found"
		| "task_owned_by_other_runtime"
		| "manager_shutting_down"
		| "invalid_task_id"
		| "unsupported_workspace_mode";

	constructor(
		code:
			| "task_not_found"
			| "task_owned_by_other_runtime"
			| "manager_shutting_down"
			| "invalid_task_id"
			| "unsupported_workspace_mode",
		message: string,
	) {
		super(message);
		this.code = code;
		this.name = "TaskManagerError";
	}
}

type ActiveTaskExecution = {
	handle: TaskExecutionHandle;
	settled: Promise<TaskRecord>;
};

type TaskManagerOptions = {
	registry?: TaskRegistryStore;
	runtimeId?: string;
	ownerPid?: number;
	now?: () => string;
	randomId?: () => string;
	sleep?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	gracePeriodMs?: number;
	processController?: TaskProcessController;
};

export class TaskManager {
	private readonly registry: TaskRegistryStore;
	private readonly runtimeId: string;
	private readonly ownerPid: number;
	private readonly now: () => string;
	private readonly randomId: () => string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly pollIntervalMs: number;
	private readonly gracePeriodMs: number;
	private readonly processController: TaskProcessController;
	private readonly activeTasks = new Map<string, ActiveTaskExecution>();
	private mutationQueue = Promise.resolve();
	private shuttingDown = false;

	constructor(options: TaskManagerOptions = {}) {
		this.registry = options.registry ?? new TaskRegistryStore();
		this.runtimeId = options.runtimeId ?? crypto.randomUUID();
		this.ownerPid = options.ownerPid ?? process.pid;
		this.now = options.now ?? nowIso;
		this.randomId = options.randomId ?? (() => crypto.randomUUID());
		this.sleep = options.sleep ?? sleepDefault;
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
		this.processController =
			options.processController ?? defaultTaskProcessController;
	}

	get ownerRuntimeId(): string {
		return this.runtimeId;
	}

	private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.mutationQueue.then(fn, fn);
		this.mutationQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async updateTask(
		taskId: string,
		updater: (current: TaskRecord) => TaskRecord,
	): Promise<TaskRecord> {
		return this.enqueueMutation(async () => {
			const current = await this.registry.get(taskId);
			if (!current) {
				throw new TaskManagerError("task_not_found", `Task not found: ${taskId}`);
			}
			const next = updater(current);
			await this.registry.upsert(next);
			return next;
		});
	}

	private async finalizeTask(
		taskId: string,
		outcome: TaskExecutionResult,
	): Promise<TaskRecord> {
		return this.updateTask(taskId, (current) => {
			if (isTerminalTaskState(current.state)) {
				return current;
			}
			const endedAt = this.now();
			return {
				...current,
				state: outcome.state,
				updated_at: endedAt,
				ended_at: current.ended_at ?? endedAt,
				result: toTaskResult(current, outcome),
				failure_message:
					outcome.failure_message ?? current.failure_message,
				cancellation_reason:
					outcome.cancellation_reason ?? current.cancellation_reason,
				cleanup_reason: outcome.cleanup_reason ?? current.cleanup_reason,
			};
		});
	}

	private async markRunning(taskId: string): Promise<TaskRecord> {
		return this.updateTask(taskId, (current) => {
			if (isTerminalTaskState(current.state)) {
				return current;
			}
			if (current.state === "running") {
				return current;
			}
			const startedAt = this.now();
			return {
				...current,
				state: "running",
				updated_at: startedAt,
				started_at: current.started_at ?? startedAt,
			};
		});
	}

	private async applyMetadata(
		taskId: string,
		metadata: TaskExecutionMetadata,
	): Promise<TaskRecord> {
		return this.updateTask(taskId, (current) => {
			if (isTerminalTaskState(current.state)) {
				return current;
			}
			return {
				...current,
				updated_at: this.now(),
				executor_pid: metadata.executor_pid ?? current.executor_pid,
				executor_pgid: metadata.executor_pgid ?? current.executor_pgid,
				child_session_id:
					metadata.child_session_id ?? current.child_session_id,
				result: metadata.worktree_path
					? {
							...current.result,
							worktree_path:
								metadata.worktree_path ?? current.result?.worktree_path,
					  }
					: current.result,
			};
		});
	}

	private async settleExecution(
		taskId: string,
		handle: TaskExecutionHandle,
	): Promise<TaskRecord> {
		try {
			const outcome = await handle.wait;
			return await this.finalizeTask(taskId, outcome);
		} catch (error) {
			return await this.finalizeTask(taskId, {
				state: "failed",
				failure_message: toErrorMessage(error),
			});
		} finally {
			this.activeTasks.delete(taskId);
		}
	}

	private async reconcileObservedTask(task: TaskRecord): Promise<TaskRecord> {
		if (isTerminalTaskState(task.state)) {
			return task;
		}
		if (this.activeTasks.has(task.task_id)) {
			return task;
		}
		if (task.owner_runtime_id !== this.runtimeId) {
			const ownerAlive = await this.processController.isProcessAlive(task.owner_pid);
			if (ownerAlive) {
				return task;
			}
			await this.terminatePersistedTask(task, "SIGTERM");
			await this.forceTerminateIfStillAlive(task);
			return this.finalizeTask(task.task_id, {
				state: "cancelled",
				cancellation_reason: OWNER_EXIT_REASON,
				cleanup_reason: OWNER_EXIT_REASON,
			});
		}
		if (task.state !== "running") {
			return task;
		}
		if (typeof task.executor_pid === "number") {
			const executorAlive = await this.processController.isProcessAlive(task.executor_pid);
			if (executorAlive) {
				return task;
			}
		}
		const cleanupReason = "task executor exited without reporting final state";
		return this.finalizeTask(task.task_id, {
			state: "failed",
			failure_message: cleanupReason,
			cleanup_reason: cleanupReason,
		});
	}

	private async requireTask(taskId: string): Promise<TaskRecord> {
		const record = await this.status(taskId);
		if (!record) {
			throw new TaskManagerError("task_not_found", `Task not found: ${taskId}`);
		}
		return record;
	}

	private async terminatePersistedTask(
		task: TaskRecord,
		signal: TaskProcessSignal,
	): Promise<void> {
		if (typeof task.executor_pgid === "number") {
			try {
				await this.processController.terminateProcessGroup(task.executor_pgid, signal);
			} catch (error) {
				if (!isErrnoCode(error, "ESRCH")) {
					throw error;
				}
			}
			return;
		}
		if (typeof task.executor_pid === "number") {
			try {
				await this.processController.terminateProcess(task.executor_pid, signal);
			} catch (error) {
				if (!isErrnoCode(error, "ESRCH")) {
					throw error;
				}
			}
		}
	}

	private async forceTerminateIfStillAlive(task: TaskRecord): Promise<void> {
		if (typeof task.executor_pid !== "number") {
			return;
		}
		const alive = await this.processController.isProcessAlive(task.executor_pid);
		if (!alive) {
			return;
		}
		await this.sleep(this.gracePeriodMs);
		const stillAlive = await this.processController.isProcessAlive(task.executor_pid);
		if (!stillAlive) {
			return;
		}
		await this.terminatePersistedTask(task, "SIGKILL");
	}

	private async cancelWithoutLocalHandle(
		task: TaskRecord,
		reason: string,
	): Promise<TaskRecord> {
		if (
			task.owner_runtime_id !== this.runtimeId &&
			(await this.processController.isProcessAlive(task.owner_pid))
		) {
			throw new TaskManagerError(
				"task_owned_by_other_runtime",
				`Task ${task.task_id} is owned by another live runtime.`,
			);
		}
		await this.terminatePersistedTask(task, "SIGTERM");
		await this.forceTerminateIfStillAlive(task);
		return this.finalizeTask(task.task_id, {
			state: "cancelled",
			cancellation_reason: reason,
		});
	}

	async spawn(
		input: TaskSpawnInput,
		startExecution: (
			context: TaskExecutionStartContext,
		) => TaskExecutionHandle | Promise<TaskExecutionHandle>,
	): Promise<TaskRecord> {
		if (this.shuttingDown) {
			throw new TaskManagerError(
				"manager_shutting_down",
				"Task manager is shutting down.",
			);
		}
		if (input.workspace_mode === "worktree") {
			throw new TaskManagerError(
				"unsupported_workspace_mode",
				"workspace_mode=worktree is not supported yet.",
			);
		}
		const taskId = input.task_id?.trim() || this.randomId();
		if (!taskId) {
			throw new TaskManagerError("invalid_task_id", "task_id is required.");
		}
		const createdAt = this.now();
		const queued: TaskRecord = {
			version: 1,
			task_id: taskId,
			kind: input.kind,
			workspace_mode: input.workspace_mode ?? "live_workspace",
			state: "queued",
			owner_runtime_id: this.runtimeId,
			owner_pid: this.ownerPid,
			key: input.key,
			label: input.label,
			title: input.title,
			working_directory: input.working_directory,
			parent_session_id: input.parent_session_id,
			parent_run_id: input.parent_run_id,
			parent_tool_call_id: input.parent_tool_call_id,
			child_session_id: input.child_session_id,
			created_at: createdAt,
			updated_at: createdAt,
		};
		await this.registry.upsert(queued);

		try {
			const handle = await startExecution({ task: queued });
			const settled = this.settleExecution(taskId, handle);
			this.activeTasks.set(taskId, { handle, settled });
			let running = await this.markRunning(taskId);
			if (handle.metadata) {
				const metadata = await handle.metadata;
				if (metadata) {
					running = await this.applyMetadata(taskId, metadata);
				}
			}
			return running;
		} catch (error) {
			return await this.finalizeTask(taskId, {
				state: "failed",
				failure_message: `task startup failed: ${toErrorMessage(error)}`,
			});
		}
	}

	async list(): Promise<TaskRecord[]> {
		const tasks = await this.registry.list();
		return Promise.all(tasks.map((task) => this.reconcileObservedTask(task)));
	}

	async status(taskId: string): Promise<TaskRecord | null> {
		const task = await this.registry.get(taskId);
		if (!task) return null;
		return this.reconcileObservedTask(task);
	}

	async result(taskId: string): Promise<TaskResult | null> {
		const task = await this.requireTask(taskId);
		if (!isTerminalTaskState(task.state)) {
			return null;
		}
		return task.result ?? null;
	}

	async readOutput(
		taskId: string,
		stream: TaskExecutionOutputStream,
	): Promise<string | null> {
		const active = this.activeTasks.get(taskId);
		if (!active?.handle.readOutput) {
			return null;
		}
		return active.handle.readOutput(stream);
	}

	async wait(
		taskId: string,
		options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
	): Promise<TaskRecord> {
		const active = this.activeTasks.get(taskId);
		if (active) {
			return withAbort(active.settled, options.signal);
		}
		const intervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
		while (true) {
			const task = await this.requireTask(taskId);
			if (isTerminalTaskState(task.state)) {
				return task;
			}
			await withAbort(this.sleep(intervalMs), options.signal);
		}
	}

	async cancel(
		taskId: string,
		options: { reason?: string } = {},
	): Promise<TaskRecord> {
		const reason = options.reason ?? "cancelled";
		const task = await this.requireTask(taskId);
		if (isTerminalTaskState(task.state)) {
			return task;
		}
		const active = this.activeTasks.get(taskId);
		if (active?.handle.cancel) {
			await active.handle.cancel(reason);
			return this.wait(taskId);
		}
		return this.cancelWithoutLocalHandle(task, reason);
	}

	async recoverOrphanedTasks(): Promise<{
		recovered: number;
		errors: Array<{ task_id: string; error: string }>;
	}> {
		const tasks = await this.registry.list();
		let recovered = 0;
		const errors: Array<{ task_id: string; error: string }> = [];
		for (const task of tasks) {
			if (isTerminalTaskState(task.state)) {
				continue;
			}
			const ownerAlive = await this.processController.isProcessAlive(task.owner_pid);
			if (ownerAlive) {
				continue;
			}
			try {
				await this.terminatePersistedTask(task, "SIGTERM");
				await this.forceTerminateIfStillAlive(task);
				await this.finalizeTask(task.task_id, {
					state: "cancelled",
					cancellation_reason: OWNER_EXIT_REASON,
					cleanup_reason: OWNER_EXIT_REASON,
				});
				recovered += 1;
			} catch (error) {
				errors.push({ task_id: task.task_id, error: toErrorMessage(error) });
			}
		}
		return { recovered, errors };
	}

	async shutdown(): Promise<{
		cancelled: number;
		errors: Array<{ task_id: string; error: string }>;
	}> {
		this.shuttingDown = true;
		const tasks = (await this.registry.list()).filter(
			(task) =>
				task.owner_runtime_id === this.runtimeId &&
				!isTerminalTaskState(task.state),
		);
		let cancelled = 0;
		const errors: Array<{ task_id: string; error: string }> = [];
		for (const task of tasks) {
			try {
				const result = await Promise.race([
					this.cancel(task.task_id, { reason: OWNER_SHUTDOWN_REASON }).then(
						(record) => ({ timedOut: false as const, record }),
					),
					this.sleep(this.gracePeriodMs).then(() => ({
						timedOut: true as const,
						record: null,
					})),
				]);
				if (result.timedOut) {
					const refreshed = await this.requireTask(task.task_id);
					if (!isTerminalTaskState(refreshed.state)) {
						await this.terminatePersistedTask(refreshed, "SIGKILL");
						await this.finalizeTask(task.task_id, {
							state: "cancelled",
							cancellation_reason: OWNER_SHUTDOWN_REASON,
							cleanup_reason: OWNER_SHUTDOWN_REASON,
						});
					}
					cancelled += 1;
					continue;
				}
				if (result.record.state === "cancelled") {
					cancelled += 1;
				}
			} catch (error) {
				errors.push({ task_id: task.task_id, error: toErrorMessage(error) });
			}
		}
		return { cancelled, errors };
	}
}
