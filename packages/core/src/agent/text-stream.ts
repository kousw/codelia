import type { TextStreamEvent } from "@codelia/shared-types";
import type { ChatInvokeCompletion } from "../types/llm/invoke";

export type TextStreamIdentity = Pick<
	TextStreamEvent,
	"stream_id" | "invocation_id" | "attempt"
>;
export type StreamedCompletion = {
	response: ChatInvokeCompletion;
	stream?: TextStreamIdentity;
};

/** One outstanding event. The provider must await the sink; returning the consumer aborts it. */
export async function* invokeTextStream(
	operation: (
		sink: (text: string) => Promise<void>,
		signal: AbortSignal,
	) => Promise<ChatInvokeCompletion>,
	identity: TextStreamIdentity,
	signal?: AbortSignal,
): AsyncGenerator<TextStreamEvent, StreamedCompletion> {
	const controller = new AbortController();
	const aborted = () =>
		Object.assign(new Error("Operation aborted"), { name: "AbortError" });
	const onAbort = () => {
		controller.abort(signal?.reason);
		wake?.();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) controller.abort(signal.reason);
	let wake: (() => void) | undefined;
	let pending:
		| {
				event: TextStreamEvent;
				resolve: () => void;
				reject: (error: Error) => void;
		  }
		| undefined;
	let settled:
		| { response: ChatInvokeCompletion }
		| { error: unknown }
		| undefined;
	let started = false;
	let offset = 0;
	let closed = false;
	let completed = false;
	const send = (event: TextStreamEvent): Promise<void> => {
		if (closed || controller.signal.aborted) return Promise.reject(aborted());
		if (pending) return Promise.reject(new Error("Text sink must be awaited"));
		return new Promise((resolve, reject) => {
			pending = { event, resolve, reject };
			wake?.();
		});
	};
	const sink = async (text: string) => {
		if (typeof text !== "string") throw new Error("Invalid model text delta");
		if (!text || offset >= 2 * 1024 * 1024) return;
		if (!started) {
			started = true;
			await send({ type: "text.stream", ...identity, phase: "start" });
		}
		// Split without cutting UTF-16 surrogate pairs; the wire offset counts UTF-8 bytes.
		let chunk = "";
		for (const character of text) {
			chunk += character;
			if (chunk.length >= 4096) {
				if (offset + Buffer.byteLength(chunk) > 2 * 1024 * 1024) return;
				await send({
					type: "text.stream",
					...identity,
					phase: "delta",
					offset,
					content: chunk,
				});
				offset += Buffer.byteLength(chunk);
				chunk = "";
				if (offset >= 2 * 1024 * 1024) return;
			}
		}
		if (chunk) {
			if (offset + Buffer.byteLength(chunk) > 2 * 1024 * 1024) return;
			await send({
				type: "text.stream",
				...identity,
				phase: "delta",
				offset,
				content: chunk,
			});
			offset += Buffer.byteLength(chunk);
		}
	};
	// Attach both handlers immediately: a consumer return must not leave an unhandled rejection.
	Promise.resolve()
		.then(() => operation(sink, controller.signal))
		.then(
			(response) => {
				settled = { response };
				wake?.();
			},
			(error) => {
				settled = { error };
				wake?.();
			},
		);
	try {
		while (true) {
			if (controller.signal.aborted) throw aborted();
			if (pending) {
				const item = pending;
				yield item.event;
				pending = undefined;
				item.resolve();
			} else if (settled) {
				if ("error" in settled) throw settled.error;
				completed = true;
				return {
					response: settled.response,
					...(started ? { stream: identity } : {}),
				};
			} else {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
			}
		}
	} catch (error) {
		if (started) yield { type: "text.stream", ...identity, phase: "discard" };
		throw error;
	} finally {
		closed = true;
		if (!completed) controller.abort();
		pending?.reject(aborted());
		signal?.removeEventListener("abort", onAbort);
	}
}
