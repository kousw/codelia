import type { ChatStreamDeltaSink } from "./base";

type ChatCompletionChunkLike = {
	choices?: Array<{
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
		} | null;
	}> | null;
};

/**
 * Forwards Chat Completions stream chunk deltas (`reasoning_content` / `content`).
 * These adapters accumulate one reasoning block and one assistant text block per
 * response, so both kinds always use index 0.
 */
export const emitChatCompletionChunkDeltas = (
	sink: ChatStreamDeltaSink,
	chunk: ChatCompletionChunkLike,
): void => {
	for (const choice of chunk.choices ?? []) {
		const delta = choice.delta;
		if (!delta) continue;
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content)
			sink({ kind: "reasoning", index: 0, delta: delta.reasoning_content });
		if (typeof delta.content === "string" && delta.content)
			sink({ kind: "text", index: 0, delta: delta.content });
	}
};
