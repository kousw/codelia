import { createHash, type Hash } from "node:crypto";
import type {
	ContentBlockParam,
	MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { BaseMessage } from "../../types/llm";

const PREFIX_KEY = "codelia_anthropic_prefix_sha256";

export const usesBoundThinking = (model: string): boolean =>
	model === "claude-sonnet-5-5" || model === "claude-haiku-5-5";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const isThinkingBlock = (
	value: unknown,
): value is Extract<
	ContentBlockParam,
	{ type: "thinking" | "redacted_thinking" }
> =>
	isRecord(value) &&
	((value.type === "thinking" &&
		typeof value.thinking === "string" &&
		typeof value.signature === "string") ||
		(value.type === "redacted_thinking" && typeof value.data === "string"));

// Object key order can change through durable JSON history without changing input.
const canonicalJson = (value: unknown): string =>
	JSON.stringify(value, (_key, item) =>
		isRecord(item) && !Array.isArray(item)
			? Object.fromEntries(
					Object.keys(item)
						.sort()
						.map((key) => [key, item[key]]),
				)
			: item,
	);

type ThinkingPrefix = {
	system?: unknown;
	tools?: unknown;
	messages: MessageParam[];
};

const startPrefix = (request: ThinkingPrefix): Hash =>
	createHash("sha256")
		.update(
			canonicalJson({
				system: request.system ?? null,
				tools: request.tools ?? [],
			}),
		)
		.update("\n");
const startMessage = (hash: Hash, role: string): Hash =>
	hash.copy().update(`${role}\n`);
const addBlock = (hash: Hash, block: unknown): void => {
	hash.update(canonicalJson(block)).update("\n");
};
const contentBlocks = (message: MessageParam): ContentBlockParam[] =>
	typeof message.content === "string"
		? [{ type: "text", text: message.content }]
		: message.content;

/** Keep only locally proven prefixes; never send local fingerprints to Claude. */
export const filterBoundThinking = (
	request: ThinkingPrefix,
): MessageParam[] => {
	let hash = startPrefix(request);
	const messages: MessageParam[] = [];
	for (const message of request.messages) {
		const nextHash = startMessage(hash, message.role);
		const content: ContentBlockParam[] = [];
		for (const block of contentBlocks(message)) {
			let clean: ContentBlockParam = block;
			if (isThinkingBlock(block)) {
				const { [PREFIX_KEY]: prefix, ...original } =
					block as unknown as Record<string, unknown>;
				if (
					prefix !== nextHash.copy().digest("hex") ||
					!isThinkingBlock(original)
				)
					continue;
				clean = original;
			}
			content.push(clean);
			addBlock(nextHash, clean);
		}
		if (content.length === 0) continue;
		messages.push({ ...message, content });
		hash = nextHash;
	}
	return messages;
};

/** Persist fingerprints with raw thinking so replay also works after restart. */
export const bindResponseThinking = (
	request: ThinkingPrefix,
	blocks: ContentBlockParam[],
	messages: BaseMessage[],
): void => {
	let hash = startPrefix(request);
	for (const message of request.messages) {
		hash = startMessage(hash, message.role);
		for (const block of contentBlocks(message)) addBlock(hash, block);
	}
	hash = startMessage(hash, "assistant");
	const prefixes = new Map<unknown, string>();
	for (const block of blocks) {
		if (isThinkingBlock(block)) prefixes.set(block, hash.copy().digest("hex"));
		addBlock(hash, block);
	}
	for (const message of messages) {
		if (message.role !== "reasoning" || !isThinkingBlock(message.raw_item))
			continue;
		const prefix = prefixes.get(message.raw_item);
		if (prefix)
			message.raw_item = { ...message.raw_item, [PREFIX_KEY]: prefix };
	}
};
