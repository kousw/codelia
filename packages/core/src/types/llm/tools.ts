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

export type HostedWebSearchToolDefinition = {
	type: "hosted_search";
	search_kind?: "web";
	name: string;
	provider?: "openai" | "anthropic" | "openrouter" | "google" | "xai";
	search_context_size?: "low" | "medium" | "high";
	allowed_domains?: string[];
	blocked_domains?: string[];
	max_uses?: number;
	user_location?: HostedSearchUserLocation;
};

export type HostedXSearchToolDefinition = {
	type: "hosted_search";
	search_kind: "x";
	name: "x_search";
	provider: "xai";
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	enable_image_understanding?: boolean;
	enable_video_understanding?: boolean;
};

export type HostedSearchToolDefinition =
	| HostedWebSearchToolDefinition
	| HostedXSearchToolDefinition;

export type ToolDefinition =
	| FunctionToolDefinition
	| HostedSearchToolDefinition;

export const isHostedSearchToolDefinition = (
	value: ToolDefinition,
): value is HostedSearchToolDefinition => value.type === "hosted_search";

export const isHostedWebSearchToolDefinition = (
	value: ToolDefinition,
): value is HostedWebSearchToolDefinition =>
	value.type === "hosted_search" && value.search_kind !== "x";

export const isHostedXSearchToolDefinition = (
	value: ToolDefinition,
): value is HostedXSearchToolDefinition =>
	value.type === "hosted_search" && value.search_kind === "x";

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
