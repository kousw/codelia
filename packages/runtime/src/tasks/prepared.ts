import type { TaskProgress } from "@codelia/shared-types";
import type { TaskExecutionHandle, TaskExecutionMetadata } from "./types";

/** prepare must not start work; TaskManager registers this handle before start. */
export type PreparedTaskExecution = TaskExecutionHandle & {
	cancel(reason?: string): Promise<void>;
	start(control: {
		persistExecutor(metadata: TaskExecutionMetadata): Promise<void>;
		running(metadata: TaskExecutionMetadata): Promise<void>;
		/** Optional in-memory progress for the parent UI (subagents). */
		progress?(progress: TaskProgress): void;
	}): Promise<void>;
};
