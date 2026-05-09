import type { ContentPart, Tool, ToolResult } from "@codelia/core";
import type { ClientToolDefinition } from "@codelia/protocol";
import type { JSONSchema7 } from "json-schema";
import type { RuntimeState } from "../runtime-state";
import { requestClientToolCall } from "../rpc/client-tool-requests";

const DEFAULT_TIMEOUT_MS = 60_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeClientToolResult = (value: unknown): ToolResult => {
	if (typeof value === "string") {
		return { type: "text", text: value };
	}
	if (isRecord(value)) {
		if (value.type === "text" && typeof value.text === "string") {
			return { type: "text", text: value.text };
		}
		if (value.type === "parts" && Array.isArray(value.parts)) {
			return { type: "parts", parts: value.parts as ContentPart[] };
		}
		if (value.type === "json" && "value" in value) {
			return { type: "json", value: value.value };
		}
	}
	return { type: "json", value };
};

const validateClientToolDefinition = (
	tool: ClientToolDefinition,
	existingNames: Set<string>,
): void => {
	if (tool.type !== undefined && tool.type !== "function") {
		throw new Error(`unsupported client tool type: ${String(tool.type)}`);
	}
	if (!tool.name || !/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
		throw new Error(`invalid client tool name: ${tool.name}`);
	}
	if (existingNames.has(tool.name)) {
		throw new Error(
			`client tool name conflicts with existing tool: ${tool.name}`,
		);
	}
	if (!tool.description.trim()) {
		throw new Error(`client tool description is required: ${tool.name}`);
	}
	if (!isRecord(tool.parameters)) {
		throw new Error(
			`client tool parameters must be a JSON schema: ${tool.name}`,
		);
	}
	if (
		tool.timeout_ms !== undefined &&
		(!Number.isFinite(tool.timeout_ms) || tool.timeout_ms <= 0)
	) {
		throw new Error(`client tool timeout_ms must be positive: ${tool.name}`);
	}
};

export const createClientToolAdapters = ({
	runId,
	tools,
	state,
	existingTools,
}: {
	runId: string;
	tools?: ClientToolDefinition[];
	state: RuntimeState;
	existingTools: Tool[];
}): Tool[] => {
	if (!tools?.length) return [];
	const existingNames = new Set(existingTools.map((tool) => tool.name));
	const clientNames = new Set<string>();
	return tools.map((clientTool) => {
		validateClientToolDefinition(clientTool, existingNames);
		if (clientNames.has(clientTool.name)) {
			throw new Error(`duplicate client tool name: ${clientTool.name}`);
		}
		clientNames.add(clientTool.name);
		const timeoutMs = clientTool.timeout_ms ?? DEFAULT_TIMEOUT_MS;
		const description = `${clientTool.description.trim()} (origin: runtime client)`;
		return {
			name: clientTool.name,
			description,
			definition: {
				name: clientTool.name,
				description,
				parameters: clientTool.parameters as JSONSchema7,
				strict: clientTool.strict ?? false,
			},
			executeRaw: async (rawArgsJson) => {
				let args: Record<string, unknown>;
				try {
					const parsed = JSON.parse(rawArgsJson);
					args = isRecord(parsed) ? parsed : { value: parsed };
				} catch (error) {
					throw new Error(
						`Invalid tool arguments JSON for ${clientTool.name}: ${String(error)}`,
					);
				}
				const response = await requestClientToolCall(
					state,
					{
						run_id: runId,
						name: clientTool.name,
						arguments: args,
						raw_arguments: rawArgsJson,
					},
					timeoutMs,
				);
				if (!response.ok) {
					throw new Error(response.error);
				}
				return normalizeClientToolResult(response.result);
			},
		} satisfies Tool;
	});
};
