import type { ContentPart, TextPart } from "./content";
import type { ToolCall } from "./tools";

/**
 * Base Message
 */
export type UserMessage = {
	role: "user";
	content: string | ContentPart[];
	name?: string;
};

export type SystemMessage = {
	role: "system";
	content: string | TextPart[];
	name?: string;
	cache?: boolean;
};

export type AssistantMessage = {
	role: "assistant";
	content: string | ContentPart[] | null;
	name?: string;
	tool_calls?: ToolCall[];
	refusal?: string | null;
};

export type ToolOutputRef = {
	id: string;
	byte_size?: number;
	line_count?: number;
};

export type ReasoningMessage<T = unknown> = {
	role: "reasoning";
	content: string | null;
	raw_item?: T | null;
};

export type ToolMessage = {
	role: "tool";
	tool_call_id: string;
	tool_name: string;
	content: string | ContentPart[];
	is_error?: boolean;
	output_ref?: ToolOutputRef;
	trimmed?: boolean;
};

export type BaseMessage =
	| UserMessage
	| SystemMessage
	| AssistantMessage
	| ToolMessage
	| ReasoningMessage;
