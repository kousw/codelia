import type { TaskExecutionHandle, TaskExecutionMetadata } from "./types";

/** prepare must not start work; TaskManager registers this handle before start. */
export type PreparedTaskExecution = TaskExecutionHandle & {
	cancel(reason?: string): Promise<void>;
	start(control: {
		persistExecutor(metadata: TaskExecutionMetadata): Promise<void>;
		running(metadata: TaskExecutionMetadata): Promise<void>;
	}): Promise<void>;
};
