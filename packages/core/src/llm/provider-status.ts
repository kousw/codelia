import type {
	LlmRetryEvent,
	LlmStatusEvent,
	ReasoningDeltaEvent,
	TextDeltaEvent,
} from "@codelia/shared-types";

/** Side events produced while a model request is in flight. */
export type ModelProgressEvent =
	| LlmStatusEvent
	| TextDeltaEvent
	| ReasoningDeltaEvent;

/** At most this many queued `llm.status` events; provisional deltas are never dropped. */
const MAX_QUEUED_STATUS = 32;

/**
 * Drain provider progress (status and opt-in provisional deltas) while the
 * existing retry generator awaits a request. Queued events are always yielded
 * before the next retry event or the completed response.
 */
export async function* withProviderStatus<T>(
	operation: (
		emit: (event: ModelProgressEvent) => void,
		signal: AbortSignal,
	) => AsyncGenerator<LlmRetryEvent, T>,
	signal?: AbortSignal,
): AsyncGenerator<LlmRetryEvent | ModelProgressEvent, T> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const queue: ModelProgressEvent[] = [];
	let queuedStatus = 0;
	let wake: (() => void) | undefined;
	let closed = false;
	const shift = (): ModelProgressEvent => {
		const event = queue.shift() as ModelProgressEvent;
		if (event.type === "llm.status") queuedStatus--;
		return event;
	};
	const iterator = operation((event) => {
		if (closed || controller.signal.aborted) return;
		if (event.type === "llm.status") {
			if (queuedStatus >= MAX_QUEUED_STATUS) return;
			queuedStatus++;
		}
		queue.push(event);
		wake?.();
	}, controller.signal);
	let pending = iterator.next();
	try {
		while (true) {
			while (queue.length) yield shift();
			const changed = new Promise<undefined>((resolve) => {
				wake = () => resolve(undefined);
			});
			const result = await Promise.race([pending, changed]);
			wake = undefined;
			if (!result) continue;
			while (queue.length) yield shift();
			if (result.done) return result.value;
			yield result.value;
			pending = iterator.next();
		}
	} finally {
		closed = true;
		controller.abort();
		signal?.removeEventListener("abort", abort);
		// A consumer may stop at a progress event while the request is pending
		// (run cancel breaks out of the stream mid-attempt): close the retry
		// generator, and a later rejection of the in-flight attempt must not
		// become an unhandled rejection.
		void pending.catch(() => {});
		void iterator.return(undefined as T).catch(() => {});
	}
}
