import type {
	Tool as AnthropicFunctionToolDefinition,
	ToolChoice as AnthropicToolChoice,
	ToolUnion as AnthropicToolUnion,
	ContentBlock,
	ContentBlockParam,
	DocumentBlockParam,
	ImageBlockParam,
	Message,
	MessageParam,
	SearchResultBlockParam,
	TextBlockParam,
	ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
	BaseMessage,
	ChatInvokeCompletion,
	ChatInvokeUsage,
	ContentPart,
	HostedSearchToolDefinition,
	ToolCall,
	ToolChoice,
	ToolDefinition,
	ToolMessage,
} from "../../types/llm";
import {
	isFunctionToolDefinition,
	isHostedSearchToolDefinition,
} from "../../types/llm";

type AnthropicContentBlock = ContentBlock;
type AnthropicContentBlockParam = ContentBlockParam;
type AnthropicMessage = MessageParam;
type ToolResultContentBlockParam =
	| TextBlockParam
	| ImageBlockParam
	| DocumentBlockParam
	| SearchResultBlockParam;
type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
type OtherPart = Extract<ContentPart, { type: "other" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const stringifyUnknown = (value: unknown): string => {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const formatOtherPart = (part: OtherPart): string => {
	const payloadText = stringifyUnknown(part.payload);
	return payloadText
		? `[other:${part.provider}/${part.kind}] ${payloadText}`
		: `[other:${part.provider}/${part.kind}]`;
};

const parseDataUrl = (
	url: string,
): { mediaType: string; data: string } | null => {
	const match = /^data:([^;]+);base64,(.+)$/.exec(url);
	if (!match) return null;
	return { mediaType: match[1], data: match[2] };
};

const isSupportedImageMediaType = (value: string): value is ImageMediaType =>
	value === "image/png" ||
	value === "image/jpeg" ||
	value === "image/webp" ||
	value === "image/gif";

const isAnthropicContentBlock = (
	value: unknown,
): value is ToolResultContentBlockParam => {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "text":
			return typeof value.text === "string";
		case "image":
			return isRecord(value.source);
		case "document":
			return isRecord(value.source);
		case "search_result":
			return true;
		default:
			return false;
	}
};

const contentPartsToText = (content: string | ContentPart[] | null): string => {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return content
		.map((part) => {
			switch (part.type) {
				case "text":
					return part.text;
				case "image_url":
					return "[image]";
				case "document":
					return "[document]";
				case "other":
					return `[other:${part.provider}/${part.kind}]`;
				default:
					return "[content]";
			}
		})
		.join("");
};

const toTextBlock = (text: string): TextBlockParam => ({
	type: "text",
	text,
});

const toContentBlocks = (
	content: string | ContentPart[] | null,
): ToolResultContentBlockParam[] => {
	if (content == null) return [];
	if (typeof content === "string") {
		return content ? [toTextBlock(content)] : [];
	}
	return content.map((part) => {
		switch (part.type) {
			case "text":
				return toTextBlock(part.text);
			case "image_url": {
				const dataUrl = parseDataUrl(part.image_url.url);
				if (dataUrl) {
					const mediaType =
						part.image_url.media_type ??
						(isSupportedImageMediaType(dataUrl.mediaType)
							? dataUrl.mediaType
							: undefined);
					if (!mediaType) {
						return toTextBlock(part.image_url.url);
					}
					return {
						type: "image",
						source: {
							type: "base64",
							media_type: mediaType,
							data: dataUrl.data,
						},
					};
				}
				return toTextBlock(part.image_url.url);
			}
			case "document":
				return toTextBlock("[document]");
			case "other":
				if (
					part.provider === "anthropic" &&
					isAnthropicContentBlock(part.payload)
				) {
					return part.payload;
				}
				return toTextBlock(formatOtherPart(part));
			default:
				return toTextBlock("");
		}
	});
};

const ensureToolResultBlocks = (
	blocks: ToolResultContentBlockParam[],
): ToolResultContentBlockParam[] =>
	blocks.length > 0 ? blocks : [toTextBlock("")];

const ensureMessageBlocks = (
	blocks: AnthropicContentBlockParam[],
): AnthropicContentBlockParam[] =>
	blocks.length > 0 ? blocks : [toTextBlock("")];

const toToolUseBlock = (call: ToolCall): AnthropicContentBlockParam => {
	let input: unknown = call.function.arguments;
	if (call.function.arguments) {
		try {
			input = JSON.parse(call.function.arguments);
		} catch {
			input = { value: call.function.arguments };
		}
	}
	return {
		type: "tool_use",
		id: call.id,
		name: call.function.name,
		input,
	};
};

const toToolResultBlock = (message: ToolMessage): ToolResultBlockParam => {
	const content =
		typeof message.content === "string"
			? message.content
			: ensureToolResultBlocks(toContentBlocks(message.content));
	return {
		type: "tool_result",
		tool_use_id: message.tool_call_id,
		content,
		...(message.is_error ? { is_error: true } : {}),
	};
};

export const toAnthropicTools = (
	tools?: ToolDefinition[] | null,
): AnthropicToolUnion[] | undefined => {
	if (!tools || tools.length === 0) return undefined;
	const mapped: AnthropicToolUnion[] = [];
	for (const tool of tools) {
		if (isFunctionToolDefinition(tool)) {
			mapped.push({
				name: tool.name,
				description: tool.description,
				input_schema:
					tool.parameters as AnthropicFunctionToolDefinition["input_schema"],
			});
			continue;
		}
		if (isHostedSearchToolDefinition(tool)) {
			const hosted = toAnthropicHostedSearchTool(tool);
			if (hosted) {
				mapped.push(hosted);
			}
		}
	}
	return mapped.length ? mapped : undefined;
};

export const toAnthropicToolChoice = (
	choice?: ToolChoice | null,
): AnthropicToolChoice | undefined => {
	if (!choice) return undefined;
	if (choice === "auto") return { type: "auto" };
	if (choice === "required") return { type: "any" };
	if (choice === "none") return undefined;
	return { type: "tool", name: choice };
};

const mergePendingToolResults = (
	pendingToolResults: ToolResultBlockParam[],
	output: AnthropicMessage[],
): void => {
	if (pendingToolResults.length === 0) return;
	output.push({
		role: "user",
		content: [...pendingToolResults],
	});
	pendingToolResults.length = 0;
};

const isToolUseBlock = (
	block: AnthropicContentBlockParam,
): block is Extract<AnthropicContentBlockParam, { type: "tool_use" }> =>
	isRecord(block) && block.type === "tool_use";

const isToolResultBlock = (
	block: AnthropicContentBlockParam,
): block is ToolResultBlockParam =>
	isRecord(block) && block.type === "tool_result";

const isAssistantWithToolUseBlocks = (
	message: AnthropicMessage,
): message is AnthropicMessage & {
	role: "assistant";
	content: AnthropicContentBlockParam[];
} =>
	message.role === "assistant" &&
	Array.isArray(message.content) &&
	message.content.some((block) => isToolUseBlock(block));

const coalesceConsecutiveAssistantToolUseMessages = (
	messages: AnthropicMessage[],
): AnthropicMessage[] => {
	const normalized: AnthropicMessage[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const current = messages[index];
		if (!isAssistantWithToolUseBlocks(current)) {
			normalized.push(current);
			continue;
		}
		const mergedBlocks: AnthropicContentBlockParam[] = [...current.content];
		let nextIndex = index + 1;
		while (nextIndex < messages.length) {
			const candidate = messages[nextIndex];
			if (!isAssistantWithToolUseBlocks(candidate)) break;
			mergedBlocks.push(...candidate.content);
			nextIndex += 1;
		}
		normalized.push({
			role: "assistant",
			content: ensureMessageBlocks(mergedBlocks),
		});
		index = nextIndex - 1;
	}
	return normalized;
};

const dropOrphanToolUseBlocks = (
	messages: AnthropicMessage[],
): AnthropicMessage[] => {
	const normalizedMessages =
		coalesceConsecutiveAssistantToolUseMessages(messages);
	const sanitized: AnthropicMessage[] = [];
	for (let index = 0; index < normalizedMessages.length; index += 1) {
		const current = normalizedMessages[index];
		if (!Array.isArray(current.content) || current.role !== "assistant") {
			sanitized.push(current);
			continue;
		}
		const toolUseIds = new Set<string>();
		for (const block of current.content) {
			if (isToolUseBlock(block)) {
				toolUseIds.add(block.id);
			}
		}
		if (toolUseIds.size === 0) {
			sanitized.push(current);
			continue;
		}
		const next = normalizedMessages[index + 1];
		if (!next || next.role !== "user" || !Array.isArray(next.content)) {
			const filtered = current.content.filter(
				(block) => !isToolUseBlock(block),
			);
			if (filtered.length > 0) {
				sanitized.push({ ...current, content: filtered });
			}
			continue;
		}
		const toolResultIds = new Set<string>();
		for (const block of next.content) {
			if (isToolResultBlock(block)) {
				toolResultIds.add(block.tool_use_id);
			}
		}
		const allowedIds = new Set<string>();
		for (const id of toolUseIds) {
			if (toolResultIds.has(id)) {
				allowedIds.add(id);
			}
		}
		const filteredCurrent = current.content.filter(
			(block) => !isToolUseBlock(block) || allowedIds.has(block.id),
		);
		if (filteredCurrent.length > 0) {
			sanitized.push({ ...current, content: filteredCurrent });
		}
		const filteredNext = next.content.filter(
			(block) => !isToolResultBlock(block) || allowedIds.has(block.tool_use_id),
		);
		if (filteredNext.length > 0) {
			sanitized.push({ ...next, content: filteredNext });
		}
		index += 1;
	}
	return sanitized;
};

export const toAnthropicMessages = (
	messages: BaseMessage[],
): { system?: string; messages: AnthropicMessage[] } => {
	const systemParts: string[] = [];
	const output: AnthropicMessage[] = [];
	const pendingToolResults: ToolResultBlockParam[] = [];

	for (const message of messages) {
		switch (message.role) {
			case "system": {
				mergePendingToolResults(pendingToolResults, output);
				const text = contentPartsToText(message.content);
				if (text) systemParts.push(text);
				break;
			}
			case "reasoning":
				break;
			case "tool": {
				pendingToolResults.push(toToolResultBlock(message));
				break;
			}
			case "assistant": {
				mergePendingToolResults(pendingToolResults, output);
				const blocks: AnthropicContentBlockParam[] = [];
				blocks.push(...toContentBlocks(message.content));
				if (message.tool_calls?.length) {
					blocks.push(...message.tool_calls.map(toToolUseBlock));
				}
				output.push({
					role: "assistant",
					content: ensureMessageBlocks(blocks),
				});
				break;
			}
			case "user": {
				mergePendingToolResults(pendingToolResults, output);
				const blocks = ensureToolResultBlocks(toContentBlocks(message.content));
				output.push({
					role: "user",
					content: blocks,
				});
				break;
			}
			default:
				break;
		}
	}

	mergePendingToolResults(pendingToolResults, output);
	const system = systemParts.length ? systemParts.join("\n\n") : undefined;
	return { system, messages: dropOrphanToolUseBlocks(output) };
};

const extractText = (blocks: AnthropicContentBlock[]): string =>
	blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");

const toUsage = (response: {
	model?: string | null;
	usage?: {
		input_tokens?: number | null;
		output_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
		cache_read_input_tokens?: number | null;
	};
}): ChatInvokeUsage | null => {
	if (!response.usage) return null;
	// Anthropic total input is the sum of base input and cache components.
	const baseInputTokens = response.usage.input_tokens ?? 0;
	const cacheCreateTokens = response.usage.cache_creation_input_tokens ?? 0;
	const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
	const inputTokens = baseInputTokens + cacheCreateTokens + cacheReadTokens;
	const outputTokens = response.usage.output_tokens ?? 0;
	return {
		model: response.model ?? "",
		input_tokens: inputTokens,
		input_cached_tokens: cacheReadTokens,
		input_cache_creation_tokens: cacheCreateTokens,
		output_tokens: outputTokens,
		total_tokens: inputTokens + outputTokens,
	};
};

export const toChatInvokeCompletion = (
	response: Message,
): ChatInvokeCompletion => {
	const blocks = response.content ?? [];
	const messages: BaseMessage[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				messages.push({
					role: "assistant",
					content: block.text,
				});
				break;
			case "tool_use":
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: block.id,
							type: "function",
							function: {
								name: block.name,
								arguments: isRecord(block.input)
									? JSON.stringify(block.input)
									: JSON.stringify({ value: block.input }),
							},
							provider_meta: block,
						},
					],
				});
				break;
			case "thinking":
				messages.push({
					role: "reasoning",
					content: block.thinking,
					raw_item: block,
				});
				break;
			case "redacted_thinking":
				messages.push({
					role: "reasoning",
					content: "[redacted]",
					raw_item: block,
				});
				break;
			default:
				messages.push({
					role: "assistant",
					content: [
						{
							type: "other",
							provider: "anthropic",
							kind: block.type,
							payload: block,
						},
					],
				});
				break;
		}
	}
	if (messages.length === 0) {
		const fallback = extractText(blocks);
		if (fallback) {
			messages.push({ role: "assistant", content: fallback });
		}
	}
	return {
		messages,
		usage: toUsage(response),
		stop_reason: response.stop_reason ?? response.stop_sequence ?? null,
		provider_meta: {
			response_id: response.id,
			model: response.model,
			raw_output_text: stringifyUnknown(extractText(blocks)),
		},
	};
};

const toAnthropicHostedSearchTool = (
	tool: HostedSearchToolDefinition,
): AnthropicToolUnion | null => {
	if (tool.provider && tool.provider !== "anthropic") {
		return null;
	}
	const userLocation = tool.user_location
		? {
				type: "approximate" as const,
				...(tool.user_location.city ? { city: tool.user_location.city } : {}),
				...(tool.user_location.country
					? { country: tool.user_location.country }
					: {}),
				...(tool.user_location.region
					? { region: tool.user_location.region }
					: {}),
				...(tool.user_location.timezone
					? { timezone: tool.user_location.timezone }
					: {}),
			}
		: undefined;
	return {
		type: "web_search_20250305",
		name: "web_search",
		...(tool.allowed_domains?.length
			? { allowed_domains: tool.allowed_domains }
			: {}),
		...(tool.blocked_domains?.length
			? { blocked_domains: tool.blocked_domains }
			: {}),
		...(typeof tool.max_uses === "number" ? { max_uses: tool.max_uses } : {}),
		...(userLocation ? { user_location: userLocation } : {}),
	};
};
