import type { ModelReasoningLevel } from "@codelia/shared-types";
import { stringifyContent } from "../../content/stringify";
import type {
	BaseMessage,
	ChatInvokeCompletion,
	ChatInvokeUsage,
	ContentPart,
	ToolCall,
	ToolChoice,
	ToolDefinition,
} from "../../types/llm";
import { isFunctionToolDefinition } from "../../types/llm";

type MoonshotTextPart = { type: "text"; text: string };
type MoonshotImagePart = {
	type: "image_url";
	image_url: { url: string };
};

export type MoonshotContent =
	| string
	| Array<MoonshotTextPart | MoonshotImagePart>;

export type MoonshotChatMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: MoonshotContent }
	| {
			role: "assistant";
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: MoonshotToolCall[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export type MoonshotTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
		strict?: boolean;
	};
};

export type MoonshotToolChoice =
	| "auto"
	| "required"
	| "none"
	| { type: "function"; function: { name: string } };

export type MoonshotToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

export type MoonshotUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	cached_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number } | null;
};

export type MoonshotChatCompletionChunk = {
	id?: string;
	model?: string;
	created?: number;
	choices?: Array<{
		index?: number;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: MoonshotUsage | null;
};

type AccumulatedToolCall = {
	index: number;
	id: string;
	name: string;
	arguments: string;
	rawChunkCount: number;
};

export type MoonshotStreamAccumulator = {
	id?: string;
	model?: string;
	content: string;
	reasoningContent: string;
	toolCalls: AccumulatedToolCall[];
	finishReason?: string | null;
	usage?: MoonshotUsage | null;
	rawChunkCount: number;
};

const stringify = (content: string | ContentPart[] | null): string =>
	stringifyContent(content, { mode: "display", joiner: "" });

const MOONSHOT_IMAGE_MEDIA_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

const toMoonshotImagePart = (
	part: Extract<ContentPart, { type: "image_url" }>,
): MoonshotImagePart => {
	const url = part.image_url.url;
	if (url.startsWith("ms://") && url.length > "ms://".length) {
		return { type: "image_url", image_url: { url } };
	}
	const separator = url.indexOf(",");
	const header = separator >= 0 ? url.slice(0, separator) : "";
	const payload = separator >= 0 ? url.slice(separator + 1) : "";
	const mediaType =
		header.startsWith("data:") && header.endsWith(";base64")
			? header.slice("data:".length, header.length - ";base64".length)
			: "";
	if (
		!header.endsWith(";base64") ||
		!MOONSHOT_IMAGE_MEDIA_TYPES.has(mediaType) ||
		!payload ||
		!BASE64_PAYLOAD.test(payload)
	) {
		throw new Error(
			"Moonshot image input must be a base64 data URL for png/jpeg/webp/gif or an ms:// file id; public image URLs are not supported",
		);
	}
	if (part.image_url.media_type && part.image_url.media_type !== mediaType) {
		throw new Error(
			`Moonshot image media_type mismatch: declared ${part.image_url.media_type}, data URL uses ${mediaType}`,
		);
	}
	return { type: "image_url", image_url: { url } };
};

const toUserContent = (content: string | ContentPart[]): MoonshotContent => {
	if (typeof content === "string") return content;
	const parts: Exclude<MoonshotContent, string> = [];
	for (const part of content) {
		if (part.type === "text") {
			parts.push(part);
		} else if (part.type === "image_url") {
			parts.push(toMoonshotImagePart(part));
		} else {
			parts.push({ type: "text", text: stringify([part]) });
		}
	}
	return parts;
};

const isMoonshotReasoning = (message: BaseMessage): boolean => {
	if (message.role !== "reasoning" || !message.content) return false;
	const raw = message.raw_item;
	return (
		typeof raw === "object" &&
		raw !== null &&
		"provider" in raw &&
		(raw as { provider?: unknown }).provider === "moonshot"
	);
};

export function toMoonshotMessages(
	messages: BaseMessage[],
): MoonshotChatMessage[] {
	const mapped: MoonshotChatMessage[] = [];
	let pendingReasoning: string | null = null;
	const pendingToolImages: Array<{
		toolName: string;
		toolCallId: string;
		image: MoonshotImagePart;
	}> = [];
	const flushPendingToolImages = (): void => {
		if (!pendingToolImages.length) return;
		const content: Exclude<MoonshotContent, string> = [];
		for (const pending of pendingToolImages) {
			content.push({
				type: "text",
				text: `Image output from tool ${pending.toolName} (call ${pending.toolCallId}).`,
			});
			content.push(pending.image);
		}
		mapped.push({ role: "user", content });
		pendingToolImages.length = 0;
	};
	for (const message of messages) {
		if (message.role !== "tool") {
			flushPendingToolImages();
		}
		switch (message.role) {
			case "system":
				mapped.push({ role: "system", content: stringify(message.content) });
				pendingReasoning = null;
				break;
			case "user":
				mapped.push({ role: "user", content: toUserContent(message.content) });
				pendingReasoning = null;
				break;
			case "reasoning":
				pendingReasoning = isMoonshotReasoning(message)
					? message.content
					: null;
				break;
			case "assistant": {
				const toolCalls = toReplayToolCalls(message.tool_calls);
				mapped.push({
					role: "assistant",
					content: stringify(message.content) || null,
					...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}),
					...(toolCalls.length ? { tool_calls: toolCalls } : {}),
				});
				pendingReasoning = null;
				break;
			}
			case "tool": {
				const textParts: ContentPart[] = [];
				for (const part of typeof message.content === "string"
					? []
					: message.content) {
					if (part.type === "image_url") {
						pendingToolImages.push({
							toolName: message.tool_name,
							toolCallId: message.tool_call_id,
							image: toMoonshotImagePart(part),
						});
					} else {
						textParts.push(part);
					}
				}
				const textContent =
					typeof message.content === "string"
						? message.content
						: textParts.length
							? stringify(textParts)
							: "";
				mapped.push({
					role: "tool",
					tool_call_id: message.tool_call_id,
					content:
						textContent ||
						`Tool ${message.tool_name} returned image output attached in the following user message.`,
				});
				pendingReasoning = null;
				break;
			}
		}
	}
	flushPendingToolImages();
	return mapped;
}

export function toMoonshotTools(
	tools?: ToolDefinition[] | null,
): MoonshotTool[] | undefined {
	if (!tools?.length) return undefined;
	const mapped = tools.filter(isFunctionToolDefinition).map((tool) => ({
		type: "function" as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...(tool.strict !== undefined ? { strict: tool.strict } : {}),
		},
	}));
	return mapped.length ? mapped : undefined;
}

export function toMoonshotToolChoice(
	choice?: ToolChoice | null,
): MoonshotToolChoice | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "required" || choice === "none") {
		return choice;
	}
	return { type: "function", function: { name: choice } };
}

export const createMoonshotStreamAccumulator =
	(): MoonshotStreamAccumulator => ({
		content: "",
		reasoningContent: "",
		toolCalls: [],
		rawChunkCount: 0,
	});

export function appendMoonshotChatCompletionChunk(
	accumulator: MoonshotStreamAccumulator,
	chunk: MoonshotChatCompletionChunk,
): void {
	accumulator.rawChunkCount += 1;
	accumulator.id ??= chunk.id;
	accumulator.model ??= chunk.model;
	accumulator.usage ??= chunk.usage ?? undefined;
	for (const choice of chunk.choices ?? []) {
		if (choice.finish_reason !== undefined) {
			accumulator.finishReason = choice.finish_reason;
		}
		const delta = choice.delta;
		if (!delta) continue;
		if (typeof delta.reasoning_content === "string") {
			accumulator.reasoningContent += delta.reasoning_content;
		}
		if (typeof delta.content === "string") {
			accumulator.content += delta.content;
		}
		for (const toolDelta of delta.tool_calls ?? []) {
			const index =
				typeof toolDelta.index === "number"
					? toolDelta.index
					: accumulator.toolCalls.length;
			let call = accumulator.toolCalls.find((entry) => entry.index === index);
			if (!call) {
				call = {
					index,
					id: toolDelta.id ?? `call_${index}`,
					name: "",
					arguments: "",
					rawChunkCount: 0,
				};
				accumulator.toolCalls.push(call);
				accumulator.toolCalls.sort((left, right) => left.index - right.index);
			}
			call.rawChunkCount += 1;
			if (toolDelta.id) call.id = toolDelta.id;
			if (typeof toolDelta.function?.name === "string") {
				call.name = toolDelta.function.name;
			}
			if (typeof toolDelta.function?.arguments === "string") {
				call.arguments += toolDelta.function.arguments;
			}
		}
	}
}

export function toMoonshotChatInvokeCompletion(
	accumulator: MoonshotStreamAccumulator,
	meta: {
		reasoningRequested: ModelReasoningLevel;
		reasoningFallback: boolean;
	},
): ChatInvokeCompletion {
	const messages: BaseMessage[] = [];
	if (accumulator.reasoningContent) {
		messages.push({
			role: "reasoning",
			content: accumulator.reasoningContent,
			raw_item: {
				provider: "moonshot",
				field: "reasoning_content",
				response_id: accumulator.id,
			},
		});
	}
	const toolCalls = accumulator.toolCalls.map(toToolCall);
	if (accumulator.content || toolCalls.length) {
		messages.push({
			role: "assistant",
			content: accumulator.content || null,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		});
	}
	return {
		messages,
		usage: normalizeUsage(accumulator),
		stop_reason: accumulator.finishReason ?? null,
		provider_meta: {
			response_id: accumulator.id,
			finish_reason: accumulator.finishReason ?? null,
			reasoning_requested: meta.reasoningRequested,
			reasoning_applied: "max",
			reasoning_effort: "max",
			reasoning_fallback: meta.reasoningFallback,
		},
	};
}

const toReplayToolCalls = (toolCalls?: ToolCall[]): MoonshotToolCall[] =>
	(toolCalls ?? []).map((call) => ({
		id: call.id,
		type: "function",
		function: { ...call.function },
	}));

const toToolCall = (call: AccumulatedToolCall): ToolCall => ({
	id: call.id,
	type: "function",
	function: { name: call.name, arguments: call.arguments },
	provider_meta: {
		provider: "moonshot",
		index: call.index,
		raw_chunk_count: call.rawChunkCount,
	},
});

const normalizeNumber = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.trunc(value)
		: 0;

const normalizeUsage = (
	accumulator: MoonshotStreamAccumulator,
): ChatInvokeUsage | null => {
	const usage = accumulator.usage;
	if (!usage) return null;
	const inputTokens = normalizeNumber(usage.prompt_tokens);
	const outputTokens = normalizeNumber(usage.completion_tokens);
	const cachedTokens = normalizeNumber(
		usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
	);
	return {
		model: accumulator.model ?? "",
		input_tokens: inputTokens,
		...(cachedTokens > 0 ? { input_cached_tokens: cachedTokens } : {}),
		output_tokens: outputTokens,
		total_tokens:
			typeof usage.total_tokens === "number"
				? normalizeNumber(usage.total_tokens)
				: inputTokens + outputTokens,
	};
};
