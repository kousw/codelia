import crypto from "node:crypto";
import type { Tool } from "@codelia/core";
import type { JSONSchema7 } from "json-schema";
import type { ResolvedMcpServerConfig } from "../config";
import type { McpClient } from "./client";

const MAX_SCHEMA_SIZE_BYTES = 64 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 100_000;
const MAX_TOOLS_LIST_PAGES = 100;

export type McpToolDescriptor = {
	name: string;
	description?: string;
	inputSchema?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isMcpToolDescriptor = (value: unknown): value is McpToolDescriptor =>
	isRecord(value) && typeof value.name === "string";

const toSlug = (value: string): string => {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return slug || "tool";
};

const hash8 = (value: string): string =>
	crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);

const clampToolName = (value: string): string => {
	if (value.length <= 63) return value;
	return value.slice(0, 63);
};

const buildToolName = (serverId: string, toolName: string): string => {
	const serverSlug = toSlug(serverId);
	const toolSlug = toSlug(toolName);
	const fingerprint = hash8(`${serverId}:${toolName}`);
	const maxPrefixLength = 63 - (fingerprint.length + 1);
	const prefix = `mcp_${serverSlug}_${toolSlug}`.slice(0, maxPrefixLength);
	return clampToolName(`${prefix}_${fingerprint}`);
};

const fallbackSchema = (): JSONSchema7 => ({
	type: "object",
	additionalProperties: true,
});

const normalizeSchema = (value: unknown): JSONSchema7 => {
	if (!isRecord(value)) return fallbackSchema();
	let encoded = "";
	try {
		encoded = JSON.stringify(value);
	} catch {
		return fallbackSchema();
	}
	if (!encoded || encoded.length > MAX_SCHEMA_SIZE_BYTES) {
		return fallbackSchema();
	}
	return value as JSONSchema7;
};

const stringifyMcpContentItem = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return JSON.stringify(value);
	if (typeof value.text === "string") return value.text;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const truncateText = (value: string, maxChars: number): string => {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}\n[truncated]`;
};

const toolResultToText = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (!isRecord(value)) {
		try {
			return JSON.stringify(value);
		} catch {
			return String(value);
		}
	}

	const content = Array.isArray(value.content) ? value.content : null;
	if (content?.length) {
		return truncateText(
			content
				.map((entry) => stringifyMcpContentItem(entry))
				.join("\n")
				.trim(),
			MAX_TOOL_OUTPUT_CHARS,
		);
	}
	if (value.structuredContent !== undefined) {
		try {
			return truncateText(
				JSON.stringify(value.structuredContent),
				MAX_TOOL_OUTPUT_CHARS,
			);
		} catch {
			return String(value.structuredContent);
		}
	}
	try {
		return truncateText(JSON.stringify(value), MAX_TOOL_OUTPUT_CHARS);
	} catch {
		return truncateText(String(value), MAX_TOOL_OUTPUT_CHARS);
	}
};

const parseNextCursor = (value: unknown): string | undefined => {
	if (!isRecord(value)) return undefined;
	if (typeof value.nextCursor === "string") return value.nextCursor;
	if (typeof value.next_cursor === "string") return value.next_cursor;
	return undefined;
};

const parseToolsList = (value: unknown): McpToolDescriptor[] => {
	if (!isRecord(value) || !Array.isArray(value.tools)) return [];
	return value.tools.filter((entry): entry is McpToolDescriptor =>
		isMcpToolDescriptor(entry),
	);
};

const isCallErrorResult = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	if (value.isError === true) return true;
	if (value.is_error === true) return true;
	return false;
};

export const hasToolCapability = (value: unknown): boolean => {
	if (!isRecord(value)) return false;
	const caps = isRecord(value.capabilities) ? value.capabilities : null;
	if (!caps) return false;
	return caps.tools !== undefined;
};

export const fetchAllMcpTools = async (
	client: McpClient,
	timeoutMs: number,
): Promise<McpToolDescriptor[]> => {
	const tools: McpToolDescriptor[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page += 1) {
		const response = await client.request(
			"tools/list",
			cursor ? { cursor } : {},
			{ timeoutMs },
		);
		tools.push(...parseToolsList(response));
		const nextCursor = parseNextCursor(response);
		if (!nextCursor) break;
		cursor = nextCursor;
	}
	return tools;
};

export const createMcpToolAdapter = (params: {
	serverId: string;
	tool: McpToolDescriptor;
	config: ResolvedMcpServerConfig;
	client: McpClient;
	describeError: (error: unknown) => string;
}): Tool => {
	const { serverId, tool, config, client, describeError } = params;
	const mappedName = buildToolName(serverId, tool.name);
	const descriptionBase =
		typeof tool.description === "string" && tool.description.trim().length > 0
			? tool.description.trim()
			: "MCP tool";
	const description = `${descriptionBase} (origin: MCP ${serverId}/${tool.name})`;
	const parameters = normalizeSchema(tool.inputSchema);

	return {
		name: mappedName,
		description,
		definition: {
			name: mappedName,
			description,
			parameters,
			strict: false,
		},
		executeRaw: async (rawArgsJson, ctx) => {
			let args: unknown;
			try {
				args = JSON.parse(rawArgsJson);
			} catch (error) {
				throw new Error(
					`Invalid tool arguments JSON for ${mappedName}: ${describeError(error)}`,
				);
			}
			const response = await client.request(
				"tools/call",
				{
					name: tool.name,
					arguments: args,
				},
				{
					timeoutMs: config.request_timeout_ms,
					signal: ctx.signal,
				},
			);
			const text = toolResultToText(response);
			if (isCallErrorResult(response)) {
				throw new Error(
					text || `MCP tool call failed (${serverId}/${tool.name})`,
				);
			}
			return { type: "text", text: text || "(empty result)" };
		},
	};
};
