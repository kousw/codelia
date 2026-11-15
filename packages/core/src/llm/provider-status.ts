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

const isDelta = (
	event: ModelProgressEvent,
): event is TextDeltaEvent | ReasoningDeltaEvent =>
	event.type === "text.delta" || event.type === "reasoning.delta";

/**
 * Drain provider progress (status and opt-in provisional deltas) while the
 * existing retry generator awaits a request. Queued events are always yielded
 * before the next retry event or the completed response.
 *
 * While the consumer is busy, a delta is merged into the last queued delta when
 * (type, stream_id, index) match, so the queue grows with the number of blocks,
 * not with the number of provider chunks. The text itself is kept in full.
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
		const last = queue[queue.length - 1];
		if (
			isDelta(event) &&
			last &&
			isDelta(last) &&
			last.type === event.type &&
			last.stream_id === event.stream_id &&
			last.index === event.index
		) {
			queue[queue.length - 1] = { ...last, delta: last.delta + event.delta };
		} else {
			queue.push(event);
		}
		wake?.();
	}, controller.signal);
	// Observe each step's rejection as soon as it exists: the loop below may be
	// suspended at a `yield` of queued events when the request fails, before
	// Promise.race attaches. The failure still reaches the caller through race.
	const next = () => {
		const step = iterator.next();
		step.catch(() => {});
		return step;
	};
	let pending = next();
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
			pending = next();
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
