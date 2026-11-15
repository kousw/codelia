import type {
	AgentEvent,
	ReasoningDeltaEvent,
	TextDeltaEvent,
} from "@codelia/shared-types";

export type StreamDeltaEvent = TextDeltaEvent | ReasoningDeltaEvent;

export const DEFAULT_TEXT_DELTA_FLUSH_MS = 40;

export const isStreamDeltaEvent = (
	event: AgentEvent,
): event is StreamDeltaEvent =>
	event.type === "text.delta" || event.type === "reasoning.delta";

export type TextDeltaCoalescer = {
	/** Queue a delta; merged with the previous pending delta when (type, stream_id, index) match. */
	push: (event: StreamDeltaEvent) => void;
	/** Send all pending deltas now, in arrival order. Call before any other run event. */
	flush: () => void;
	/** Drop pending deltas and stop the timer (cancel / abort / error / run end). */
	dispose: () => void;
};

/**
 * Batches provisional deltas for one run. Only consecutive deltas with the same
 * key are merged, so interleaving across blocks/kinds and ordering relative to
 * other events is preserved; concatenation per (stream_id, index) is unchanged.
 */
export const createTextDeltaCoalescer = (options: {
	send: (event: StreamDeltaEvent) => void;
	flushMs?: number;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}): TextDeltaCoalescer => {
	const flushMs = options.flushMs ?? DEFAULT_TEXT_DELTA_FLUSH_MS;
	const setTimer =
		options.setTimer ??
		((callback: () => void, ms: number) => setTimeout(callback, ms));
	const clearTimer =
		options.clearTimer ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));
	let pending: StreamDeltaEvent[] = [];
	let timer: unknown = null;
	let disposed = false;

	const stopTimer = (): void => {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
	};

	const flush = (): void => {
		stopTimer();
		if (pending.length === 0) return;
		const batch = pending;
		pending = [];
		for (const event of batch) options.send(event);
	};

	return {
		push: (event) => {
			if (disposed) return;
			const last = pending[pending.length - 1];
			if (
				last &&
				last.type === event.type &&
				last.stream_id === event.stream_id &&
				last.index === event.index
			) {
				pending[pending.length - 1] = {
					...last,
					delta: last.delta + event.delta,
				};
			} else {
				pending.push({ ...event });
			}
			if (timer === null) timer = setTimer(flush, flushMs);
		},
		flush,
		dispose: () => {
			disposed = true;
			stopTimer();
			pending = [];
		},
	};
};
