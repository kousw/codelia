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
export type ToolDefinition = {
	name: string;
	description: string;
	parameters: JSONSchema7;
	strict?: boolean;
};

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
