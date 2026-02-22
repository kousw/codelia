import type { JSONSchema7 } from "json-schema";
import type { ContentPart } from "./content";

/**
 * Tool Call
 */
export type ToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
	provider_meta?: unknown;
};

/**
 * Tool Definition
 */
export type FunctionToolDefinition = {
	type?: "function";
	name: string;
	description: string;
	parameters: JSONSchema7;
	strict?: boolean;
};

export type HostedSearchUserLocation = {
	city?: string;
	country?: string;
	region?: string;
	timezone?: string;
};

export type HostedSearchToolDefinition = {
	type: "hosted_search";
	name: string;
	provider?: "openai" | "anthropic" | "openrouter" | "google";
	search_context_size?: "low" | "medium" | "high";
	allowed_domains?: string[];
	blocked_domains?: string[];
	max_uses?: number;
	user_location?: HostedSearchUserLocation;
};

export type ToolDefinition =
	| FunctionToolDefinition
	| HostedSearchToolDefinition;

export const isHostedSearchToolDefinition = (
	value: ToolDefinition,
): value is HostedSearchToolDefinition => value.type === "hosted_search";

export const isFunctionToolDefinition = (
	value: ToolDefinition,
): value is FunctionToolDefinition => value.type !== "hosted_search";

export type ToolChoice = "auto" | "required" | "none" | string; // string は tool name 強制

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| { [key: string]: JsonValue }
	| JsonValue[];

export type ToolResult =
	| { type: "text"; text: string }
	| { type: "parts"; parts: ContentPart[] }
	| { type: "json"; value: unknown };

export type ToolReturn = ToolResult | string | ContentPart[] | JsonValue;
