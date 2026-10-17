import type { LlmRetryEvent, LlmStatusEvent } from "@codelia/shared-types";

/** Drain provider progress while the existing retry generator awaits a request. */
export async function* withProviderStatus<T>(
	operation: (
		emit: (event: LlmStatusEvent) => void,
		signal: AbortSignal,
	) => AsyncGenerator<LlmRetryEvent, T>,
	signal?: AbortSignal,
): AsyncGenerator<LlmRetryEvent | LlmStatusEvent, T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const queue: LlmStatusEvent[] = [];
	let wake: (() => void) | undefined;
	let closed = false;
	const iterator = operation((event) => {
		if (closed || controller.signal.aborted) return;
		if (queue.length < 32) queue.push(event);
		wake?.();
	}, controller.signal);
	let pending = iterator.next();
	try {
		while (true) {
			while (queue.length) yield queue.shift() as LlmStatusEvent;
			const changed = new Promise<undefined>((resolve) => {
				wake = () => resolve(undefined);
			});
			const result = await Promise.race([pending, changed]);
			wake = undefined;
			if (!result) continue;
			while (queue.length) yield queue.shift() as LlmStatusEvent;
			if (result.done) return result.value;
			yield result.value;
			pending = iterator.next();
		}
	} finally {
		closed = true;
		controller.abort();
		signal?.removeEventListener("abort", abort);
		// A consumer may stop at a progress event while the request is pending.
		void pending.catch(() => {});
		void iterator.return(undefined as T).catch(() => {});
	}
}
