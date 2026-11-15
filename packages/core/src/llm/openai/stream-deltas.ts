import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ChatStreamDeltaSink } from "../base";

export type OpenAiDeltaObserver = {
	observe: (event: ResponseStreamEvent) => void;
	/**
	 * Called when a transport attempt inside one `ainvoke` fails and another
	 * transport attempt follows (websocket retry / HTTP fallback). If deltas were
	 * already emitted, further deltas are suppressed so the same stream never
	 * repeats text; the complete events remain authoritative.
	 */
	sealIfEmitted: () => void;
};

type ReasoningItemState = {
	source: "summary" | "content";
	lastPartIndex: number;
};

/**
 * Maps Responses stream events to provider-neutral deltas.
 * `index` is assigned per kind in order of the first delta of each output item
 * and groups deltas only (see ChatStreamDelta). Multiple reasoning summary parts
 * are separated by "\n", matching how the complete reasoning text is joined.
 */
export const createOpenAiDeltaObserver = (
	sink: ChatStreamDeltaSink,
): OpenAiDeltaObserver => {
	const textIndexByOutput = new Map<number, number>();
	const reasoningIndexByOutput = new Map<number, number>();
	const reasoningState = new Map<number, ReasoningItemState>();
	let emitted = false;
	let sealed = false;

	const indexFor = (map: Map<number, number>, outputIndex: number): number => {
		let index = map.get(outputIndex);
		if (index === undefined) {
			index = map.size;
			map.set(outputIndex, index);
		}
		return index;
	};

	const emit = (
		kind: "text" | "reasoning",
		index: number,
		delta: string,
	): void => {
		emitted = true;
		sink({ kind, index, delta });
	};

	const emitReasoning = (
		outputIndex: number,
		source: ReasoningItemState["source"],
		partIndex: number,
		delta: string,
	): void => {
		const state = reasoningState.get(outputIndex);
		if (state && state.source === "summary" && source === "content") return;
		let text = delta;
		if (!state || state.source !== source) {
			reasoningState.set(outputIndex, { source, lastPartIndex: partIndex });
		} else if (state.lastPartIndex !== partIndex) {
			state.lastPartIndex = partIndex;
			text = `\n${delta}`;
		}
		emit("reasoning", indexFor(reasoningIndexByOutput, outputIndex), text);
	};

	return {
		observe: (event) => {
			if (sealed) return;
			switch (event.type) {
				case "response.output_text.delta": {
					if (!event.delta) return;
					emit(
						"text",
						indexFor(textIndexByOutput, event.output_index),
						event.delta,
					);
					return;
				}
				case "response.reasoning_summary_text.delta": {
					if (!event.delta) return;
					emitReasoning(
						event.output_index,
						"summary",
						event.summary_index,
						event.delta,
					);
					return;
				}
				case "response.reasoning_text.delta": {
					if (!event.delta) return;
					emitReasoning(
						event.output_index,
						"content",
						event.content_index,
						event.delta,
					);
					return;
				}
				default:
					return;
			}
		},
		sealIfEmitted: () => {
			if (emitted) sealed = true;
		},
	};
};
