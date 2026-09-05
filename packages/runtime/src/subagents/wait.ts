import type { AgentTreeCoordinator } from "./coordinator";

/** A child's question must wake a parent that is waiting for that child. */
export const waitForTaskOrMessage = async (
	coordinator: AgentTreeCoordinator,
	owner: string,
	taskId: string,
	signal?: AbortSignal,
) => {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(120000);
	const combined = AbortSignal.any([
		controller.signal,
		timeout,
		...(signal ? [signal] : []),
	]);
	try {
		await Promise.race([
			coordinator.tasks.wait(taskId, { signal: combined }),
			coordinator.mailbox.receive(owner, "parent", 120, combined, false),
		]);
	} catch (error) {
		if (!combined.aborted) throw error;
	} finally {
		controller.abort();
	}
	return coordinator.requireOwned(taskId, owner);
};
