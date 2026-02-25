import type {
	Tool as OpenAITool,
	ToolChoiceFunction as OpenAIToolChoiceFunction,
	ToolChoiceOptions as OpenAIToolChoiceOptions,
	Response,
	ResponseFunctionToolCall,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type {
	BaseMessage,
	ChatInvokeCompletion,
	ChatInvokeUsage,
	ContentPart,
	HostedSearchToolDefinition,
	ToolCall,
	ToolChoice,
	ToolDefinition,
} from "../../types/llm";
import {
	isFunctionToolDefinition,
	isHostedSearchToolDefinition,
} from "../../types/llm";
import {
	extractOutputText,
	toFunctionCallOutput as toFunctionCallOutputContent,
	toResponseInputContents,
} from "./response-utils";

const toOpenAiOtherPart = (kind: string, payload: unknown): ContentPart => ({
	type: "other",
	provider: "openai",
	kind,
	payload,
});

const toAssistantOutputMessageContent = (
	item: Extract<ResponseOutputItem, { type: "message" }>,
): string | ContentPart[] | null => {
	const contents = item.content ?? [];
	if (contents.length === 0) {
		return null;
	}
	const parts: ContentPart[] = contents.map((part) => {
		if (part.type === "output_text") {
			return { type: "text", text: part.text };
		}
		return toOpenAiOtherPart(part.type, part);
	});
	return parts;
};

type OpenAIAssistantInputContent =
	| { type: "output_text"; text: string; annotations?: unknown[] }
	| { type: "refusal"; refusal: string };

const stringifyUnknown = (value: unknown): string => {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const formatOtherPart = (
	part: Extract<ContentPart, { type: "other" }>,
): string => {
	const payloadText = stringifyUnknown(part.payload);
	return payloadText
		? `[other:${part.provider}/${part.kind}] ${payloadText}`
		: `[other:${part.provider}/${part.kind}]`;
};

const isOpenAIAssistantInputContent = (
	value: unknown,
): value is OpenAIAssistantInputContent => {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "output_text") {
		return typeof record.text === "string";
	}
	if (record.type === "refusal") {
		return typeof record.refusal === "string";
	}
	return false;
};

const isReplayableOpenAIFunctionCallItem = (
	value: unknown,
): value is ResponseFunctionToolCall => {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.type === "function_call" &&
		typeof record.call_id === "string" &&
		typeof record.name === "string" &&
		typeof record.arguments === "string"
	);
};

const toReplayableFunctionCallItemId = (value: unknown): string | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}
	return value.startsWith("fc") ? value : undefined;
};

const toAssistantInputContent = (
	part: ContentPart,
): OpenAIAssistantInputContent => {
	switch (part.type) {
		case "text":
			return { type: "output_text", text: part.text };
		case "other":
			if (
				part.provider === "openai" &&
				isOpenAIAssistantInputContent(part.payload)
			) {
				return part.payload;
			}
			return { type: "output_text", text: formatOtherPart(part) };
		case "image_url":
			return { type: "output_text", text: "[image]" };
		case "document":
			return { type: "output_text", text: "[document]" };
		default:
			return { type: "output_text", text: "" };
	}
};

const toAssistantInputMessageContent = (
	content: string | ContentPart[] | null,
	refusal?: string | null,
): OpenAIAssistantInputContent[] => {
	const parts: OpenAIAssistantInputContent[] = [];
	if (typeof content === "string") {
		if (content) {
			parts.push({ type: "output_text", text: content });
		}
	} else if (Array.isArray(content)) {
		parts.push(...content.map(toAssistantInputContent));
	}
	if (refusal) {
		parts.push({ type: "refusal", refusal });
	}
	return parts;
};

const extractReasoningText = (
	item: Extract<ResponseOutputItem, { type: "reasoning" }>,
): string => {
	const summaryText = (item.summary ?? [])
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String(part.text ?? "")
				: "",
		)
		.filter((text) => text.length > 0)
		.join("\n");
	if (summaryText) return summaryText;
	const contentText = (item.content ?? [])
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String(part.text ?? "")
				: "",
		)
		.filter((text) => text.length > 0)
		.join("\n");
	return contentText;
};

const extractWebSearchSummary = (
	item: Extract<ResponseOutputItem, { type: "web_search_call" }>,
): string => {
	const parts = [`WebSearch status=${item.status}`];
	const record = item as unknown as {
		action?: {
			queries?: unknown;
			sources?: unknown;
		};
	};
	const queries = Array.isArray(record.action?.queries)
		? record.action?.queries.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.length > 0,
			)
		: [];
	if (queries.length) {
		parts.push(`queries=${queries.join(" | ")}`);
	}
	const sources = Array.isArray(record.action?.sources)
		? record.action?.sources
		: [];
	if (sources.length) {
		parts.push(`sources=${sources.length}`);
	}
	return parts.join(" | ");
};

const toMessageSequence = (response: Response): BaseMessage[] => {
	const messages: BaseMessage[] = [];
	for (const item of response.output) {
		switch (item.type) {
			case "reasoning": {
				messages.push({
					role: "reasoning",
					content: extractReasoningText(item),
					raw_item: item,
				});
				break;
			}
			case "function_call": {
				const toolCall: ToolCall = {
					id: item.call_id,
					type: "function",
					function: { name: item.name, arguments: item.arguments },
					provider_meta: item,
				};
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [toolCall],
				});
				break;
			}
			case "message": {
				messages.push({
					role: "assistant",
					content: toAssistantOutputMessageContent(item),
				});
				break;
			}
			case "web_search_call": {
				messages.push({
					role: "reasoning",
					content: extractWebSearchSummary(item),
					raw_item: item,
				});
				break;
			}
			default: {
				messages.push({
					role: "assistant",
					content: [toOpenAiOtherPart(item.type, item)],
				});
				break;
			}
		}
	}
	return messages;
};

export function extractInstructions(
	messages: BaseMessage[],
): string | undefined {
	const chunks: string[] = [];
	for (const message of messages) {
		if (message.role !== "system") {
			continue;
		}
		const content = message.content;
		if (content == null) {
			continue;
		}
		if (typeof content === "string") {
			const trimmed = content.trim();
			if (trimmed) {
				chunks.push(trimmed);
			}
			continue;
		}
		const text = content
			.map((part) => {
				switch (part.type) {
					case "text":
						return part.text;
					default:
						return "";
				}
			})
			.join("")
			.trim();
		if (text) {
			chunks.push(text);
		}
	}
	return chunks.length ? chunks.join("\n\n") : undefined;
}

export function toResponsesInput(messages: BaseMessage[]): ResponseInputItem[] {
	const items: ResponseInputItem[] = [];

	for (const message of messages) {
		if (message.role === "system") {
			continue;
		}
		if (message.role === "tool") {
			items.push(toFunctionCallOutputItem(message));
			continue;
		}

		if (message.role === "assistant" && message.tool_calls?.length) {
			// Preserve assistant content replay for OpenAI prompt-cache stability.
			const assistantMessageItem = toAssistantMessageItem(message);
			if (assistantMessageItem) {
				items.push(assistantMessageItem);
			}
			for (const call of message.tool_calls) {
				items.push(toFunctionCallItem(call));
			}
			continue;
		}

		if (message.role === "reasoning") {
			// Keep restore baseline provider-neutral: user/assistant/tool-call only.
			continue;
		}

		if (message.role === "assistant") {
			const assistantMessageItem = toAssistantMessageItem(message);
			if (assistantMessageItem) {
				items.push(assistantMessageItem);
			}
			continue;
		}

		items.push({
			type: "message",
			role: message.role,
			content: toUserMessageContent(message.content),
		});
	}

	return items;
}

export function toResponsesTools(
	tools?: ToolDefinition[] | null,
): OpenAITool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	const mapped: OpenAITool[] = [];
	for (const tool of tools) {
		if (isFunctionToolDefinition(tool)) {
			mapped.push({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters as Record<string, unknown>,
				strict: tool.strict ?? false,
			});
			continue;
		}
		if (isHostedSearchToolDefinition(tool)) {
			const hosted = toOpenAiHostedSearchTool(tool);
			if (hosted) {
				mapped.push(hosted);
			}
		}
	}
	return mapped.length ? mapped : undefined;
}

export function toResponsesToolChoice(
	choice?: ToolChoice | null,
): OpenAIToolChoiceOptions | OpenAIToolChoiceFunction | undefined {
	if (!choice) {
		return undefined;
	}
	if (choice === "auto" || choice === "required" || choice === "none") {
		return choice;
	}
	return { type: "function", name: choice };
}

export function toChatInvokeCompletion(
	response: Response,
	meta?: {
		transport?: "http_stream" | "ws_mode";
		websocket_mode?: "off" | "auto" | "on";
		fallback_used?: boolean;
		chain_reset?: boolean;
		ws_reconnect_count?: number;
		ws_input_mode?: "full_no_previous" | "full_regenerated" | "incremental" | "empty";
	},
): ChatInvokeCompletion {
	const usage: ChatInvokeUsage | null = response.usage
		? {
				model: response.model,
				input_tokens: response.usage.input_tokens,
				input_cached_tokens: response.usage.input_tokens_details?.cached_tokens,
				output_tokens: response.usage.output_tokens,
				total_tokens: response.usage.total_tokens,
			}
		: null;

	const messages = toMessageSequence(response);
	if (!messages.length) {
		const fallbackText =
			typeof response.output_text === "string"
				? response.output_text
				: extractOutputText(response.output);
		if (fallbackText) {
			messages.push({ role: "assistant", content: fallbackText });
		}
	}

	return {
		messages,
		usage,
		stop_reason: response.incomplete_details?.reason ?? response.status ?? null,
		provider_meta: {
			response_id: response.id,
			...(meta?.transport ? { transport: meta.transport } : {}),
			...(meta?.websocket_mode
				? { websocket_mode: meta.websocket_mode }
				: {}),
			...(typeof meta?.fallback_used === "boolean"
				? { fallback_used: meta.fallback_used }
				: {}),
			...(typeof meta?.chain_reset === "boolean"
				? { chain_reset: meta.chain_reset }
				: {}),
			...(typeof meta?.ws_reconnect_count === "number"
				? { ws_reconnect_count: meta.ws_reconnect_count }
				: {}),
			...(typeof meta?.ws_input_mode === "string"
				? { ws_input_mode: meta.ws_input_mode }
				: {}),
		},
	};
}

// helper functions

function toUserMessageContent(
	content: string | ContentPart[] | null,
): string | ResponseInputContent[] {
	return toResponseInputContents(content);
}

function toAssistantMessageItem(
	message: Extract<BaseMessage, { role: "assistant" }>,
): ResponseInputItem | null {
	const content = toAssistantInputMessageContent(
		message.content,
		message.refusal,
	);
	if (content.length === 0) {
		return null;
	}
	// OpenAI Codex restore requires assistant content parts to be output_text/refusal.
	return {
		type: "message",
		role: "assistant",
		content,
	} as ResponseInputItem;
}

function toFunctionCallItem(call: ToolCall): ResponseFunctionToolCall {
	if (isReplayableOpenAIFunctionCallItem(call.provider_meta)) {
		// Keep only provider-neutral function_call fields.
		// Provider-specific extras (e.g. content/items extensions) are not replayed.
		const replayable = call.provider_meta as ResponseFunctionToolCall & {
			id?: unknown;
			status?: unknown;
		};
		const replayableId = toReplayableFunctionCallItemId(replayable.id);
		return {
			type: "function_call",
			call_id: replayable.call_id,
			name: replayable.name,
			arguments: replayable.arguments,
			...(replayableId ? { id: replayableId } : {}),
			...(typeof replayable.status === "string"
				? { status: replayable.status }
				: {}),
		};
	}
	return {
		type: "function_call",
		call_id: call.id,
		name: call.function.name,
		arguments: call.function.arguments,
	};
}

function toFunctionCallOutputItem(
	message: Extract<BaseMessage, { role: "tool" }>,
): ResponseInputItem {
	return {
		type: "function_call_output",
		call_id: message.tool_call_id,
		output: toFunctionCallOutputContent(message.content),
	};
}

// OpenAI/OpenRouter share the same Responses-hosted web_search tool shape.
const isResponsesHostedSearchProvider = (
	provider: HostedSearchToolDefinition["provider"] | undefined,
): boolean =>
	provider === undefined || provider === "openai" || provider === "openrouter";

function toOpenAiHostedSearchTool(
	tool: HostedSearchToolDefinition,
): OpenAITool | null {
	if (!isResponsesHostedSearchProvider(tool.provider)) {
		return null;
	}
	const userLocation = tool.user_location
		? ({
				type: "approximate",
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
			} as const)
		: undefined;
	return {
		type: "web_search",
		...(tool.search_context_size
			? { search_context_size: tool.search_context_size }
			: {}),
		...(tool.allowed_domains?.length
			? {
					filters: {
						allowed_domains: tool.allowed_domains,
					},
				}
			: {}),
		...(userLocation ? { user_location: userLocation } : {}),
	};
}
