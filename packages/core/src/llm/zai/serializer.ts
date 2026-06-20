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
import {
	isFunctionToolDefinition,
	isHostedSearchToolDefinition,
} from "../../types/llm";

export type ZaiChatMessage =
	| {
			role: "system" | "user";
			content: string;
	  }
	| {
			role: "assistant";
			content?: string | null;
			tool_calls?: ZaiToolCall[];
	  }
	| {
			role: "tool";
			tool_call_id: string;
			content: string;
	  };

export type ZaiTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: unknown;
	};
};

export type ZaiToolChoice =
	| "auto"
	| "required"
	| "none"
	| {
			type: "function";
			function: { name: string };
	  };

export type ZaiToolCall = {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
};

export type ZaiUsage = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
};

export type ZaiChatCompletionChunk = {
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
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ZaiUsage | null;
};

type ZaiAccumulatedToolCall = {
	index: number;
	id: string;
	type: "function";
	name: string;
	arguments: string;
	raw_chunk_count: number;
};

export type ZaiStreamAccumulator = {
	id?: string;
	model?: string;
	created?: number;
	content: string;
	reasoningContent: string;
	toolCalls: ZaiAccumulatedToolCall[];
	finishReason?: string | null;
	usage?: ZaiUsage | null;
	rawChunkCount: number;
	rawChunks: ZaiChatCompletionChunk[];
	captureRawChunks: boolean;
};

const stringifyContentForZai = (
	content: string | ContentPart[] | null,
): string => stringifyContent(content, { mode: "display", joiner: "" });

export function toZaiMessages(messages: BaseMessage[]): ZaiChatMessage[] {
	const mapped: ZaiChatMessage[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "system":
			case "user": {
				mapped.push({
					role: message.role,
					content: stringifyContentForZai(message.content),
				});
				break;
			}
			case "assistant": {
				const content = stringifyContentForZai(message.content);
				const toolCalls = toZaiReplayToolCalls(message.tool_calls);
				mapped.push({
					role: "assistant",
					content: content || null,
					...(toolCalls.length ? { tool_calls: toolCalls } : {}),
				});
				break;
			}
			case "tool": {
				mapped.push({
					role: "tool",
					tool_call_id: message.tool_call_id,
					content: stringifyContentForZai(message.content),
				});
				break;
			}
			case "reasoning":
				break;
		}
	}
	return mapped;
}

export function toZaiTools(
	tools?: ToolDefinition[] | null,
): ZaiTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	const mapped: ZaiTool[] = [];
	for (const tool of tools) {
		if (isFunctionToolDefinition(tool)) {
			mapped.push({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				},
			});
			continue;
		}
		if (isHostedSearchToolDefinition(tool)) {
			continue;
		}
	}
	return mapped.length ? mapped : undefined;
}

export function toZaiToolChoice(
	choice?: ToolChoice | null,
): ZaiToolChoice | undefined {
	if (!choice) {
		return undefined;
	}
	if (choice === "auto" || choice === "required" || choice === "none") {
		return choice;
	}
	return { type: "function", function: { name: choice } };
}

export const createZaiStreamAccumulator = (options?: {
	captureRawChunks?: boolean;
}): ZaiStreamAccumulator => ({
	content: "",
	reasoningContent: "",
	toolCalls: [],
	rawChunkCount: 0,
	rawChunks: [],
	captureRawChunks: options?.captureRawChunks ?? false,
});

export function appendZaiChatCompletionChunk(
	accumulator: ZaiStreamAccumulator,
	chunk: ZaiChatCompletionChunk,
): void {
	accumulator.rawChunkCount += 1;
	if (accumulator.captureRawChunks) {
		accumulator.rawChunks.push(chunk);
	}
	accumulator.id ??= chunk.id;
	accumulator.model ??= chunk.model;
	accumulator.created ??= chunk.created;
	accumulator.usage ??= chunk.usage ?? undefined;

	for (const choice of chunk.choices ?? []) {
		if (choice.finish_reason !== undefined) {
			accumulator.finishReason = choice.finish_reason;
		}
		const delta = choice.delta;
		if (!delta) {
			continue;
		}
		if (typeof delta.reasoning_content === "string") {
			accumulator.reasoningContent += delta.reasoning_content;
		}
		if (typeof delta.content === "string") {
			accumulator.content += delta.content;
		}
		for (const toolCallDelta of delta.tool_calls ?? []) {
			const index =
				typeof toolCallDelta.index === "number"
					? toolCallDelta.index
					: accumulator.toolCalls.length;
			let call = accumulator.toolCalls.find((entry) => entry.index === index);
			if (!call) {
				call = {
					index,
					id: toolCallDelta.id ?? `call_${index}`,
					type: "function",
					name: "",
					arguments: "",
					raw_chunk_count: 0,
				};
				accumulator.toolCalls.push(call);
				accumulator.toolCalls.sort((left, right) => left.index - right.index);
			}
			call.raw_chunk_count += 1;
			if (typeof toolCallDelta.id === "string" && toolCallDelta.id) {
				call.id = toolCallDelta.id;
			}
			if (toolCallDelta.type === "function") {
				call.type = "function";
			}
			if (typeof toolCallDelta.function?.name === "string") {
				call.name = toolCallDelta.function.name;
			}
			if (typeof toolCallDelta.function?.arguments === "string") {
				call.arguments += toolCallDelta.function.arguments;
			}
		}
	}
}

export function toZaiChatInvokeCompletion(
	accumulator: ZaiStreamAccumulator,
	meta?: {
		reasoning_requested?: "low" | "medium" | "high" | "xhigh";
		reasoning_applied?: "high" | "xhigh";
		reasoning_effort?: "high" | "max";
		reasoning_fallback?: boolean;
		request_id?: string | null;
	},
): ChatInvokeCompletion {
	const messages: BaseMessage[] = [];
	if (accumulator.reasoningContent) {
		messages.push({
			role: "reasoning",
			content: accumulator.reasoningContent,
			raw_item: {
				provider: "zai",
				field: "reasoning_content",
				response_id: accumulator.id,
			},
		});
	}
	const toolCalls = accumulator.toolCalls
		.filter((call) => call.name || call.arguments || call.id)
		.map(toToolCall);
	if (accumulator.content || toolCalls.length) {
		messages.push({
			role: "assistant",
			content: accumulator.content || null,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		});
	}
	const usage = normalizeZaiUsage(accumulator);
	return {
		messages,
		usage,
		stop_reason: accumulator.finishReason ?? null,
		provider_meta: {
			response_id: accumulator.id,
			request_id: meta?.request_id ?? undefined,
			finish_reason: accumulator.finishReason ?? null,
			reasoning_requested: meta?.reasoning_requested,
			reasoning_applied: meta?.reasoning_applied,
			reasoning_effort: meta?.reasoning_effort,
			reasoning_fallback: meta?.reasoning_fallback,
		},
	};
}

const toZaiReplayToolCalls = (
	toolCalls: ToolCall[] | undefined,
): ZaiToolCall[] => {
	if (!toolCalls?.length) {
		return [];
	}
	return toolCalls.map((call) => ({
		id: call.id,
		type: "function",
		function: {
			name: call.function.name,
			arguments: call.function.arguments,
		},
	}));
};

const toToolCall = (call: ZaiAccumulatedToolCall): ToolCall => ({
	id: call.id,
	type: "function",
	function: {
		name: call.name,
		arguments: call.arguments,
	},
	provider_meta: {
		provider: "zai",
		index: call.index,
		raw_chunk_count: call.raw_chunk_count,
	},
});

const normalizeNumber = (value: unknown): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return 0;
	}
	return Math.trunc(value);
};

const normalizeZaiUsage = (
	accumulator: ZaiStreamAccumulator,
): ChatInvokeUsage | null => {
	const usage = accumulator.usage;
	if (!usage) {
		return null;
	}
	const inputTokens = normalizeNumber(usage.prompt_tokens);
	const outputTokens = normalizeNumber(usage.completion_tokens);
	const totalTokens =
		typeof usage.total_tokens === "number"
			? normalizeNumber(usage.total_tokens)
			: inputTokens + outputTokens;
	return {
		model: accumulator.model ?? "",
		input_tokens: inputTokens,
		output_tokens: outputTokens,
		total_tokens: totalTokens,
	};
};
