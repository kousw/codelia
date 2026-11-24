import { TaskManager } from "../../src/tasks";

const managers = new Set<TaskManager>();

/** A TaskManager that `settleTaskManagers` shuts down before its storage is removed. */
export const trackedTaskManager = (
	options: ConstructorParameters<typeof TaskManager>[0],
): TaskManager => {
	const manager = new TaskManager(options);
	managers.add(manager);
	return manager;
};

/**
 * Stop tracked managers and wait for their pending registry writes. Call it
 * before deleting a test's storage, so a finished task cannot write into a
 * removed directory while the next test runs.
 */
export const settleTaskManagers = async (): Promise<void> => {
	const pending = [...managers];
	managers.clear();
	const settled = await Promise.allSettled(
		pending.map((manager) => manager.shutdown()),
	);
	const failures: string[] = [];
	for (const result of settled) {
		if (result.status === "rejected") {
			failures.push(
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason),
			);
			continue;
		}
		for (const error of result.value.errors) {
			failures.push(`${error.task_id}: ${error.error}`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`TaskManager shutdown failed: ${failures.join("; ")}`);
	}
};
