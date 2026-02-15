import type { Agent, DependencyKey, ToolContext, ToolResult } from "@codelia/core";
import type { ToolCallParams, ToolCallResult } from "@codelia/protocol";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

const normalizeToolResult = (result: ToolResult): unknown => {
	switch (result.type) {
		case "json":
			return result.value;
		case "text":
			return result.text;
		case "parts":
			return result.parts;
	}
};

const createToolContext = (): ToolContext => {
	const deps: Record<string, unknown> = Object.create(null);
	const cache = new Map<string, unknown>();
	const resolve = async <T>(key: DependencyKey<T>): Promise<T> => {
		if (cache.has(key.id)) {
			return cache.get(key.id) as T;
		}
		const value = await key.create();
		cache.set(key.id, value);
		return value;
	};
	return {
		deps,
		resolve,
		now: () => new Date(),
	};
};

export const createToolHandlers = ({
	state,
	getAgent,
}: {
	state: RuntimeState;
	getAgent: () => Promise<Agent>;
}) => {
	const handleToolCall = async (
		id: string,
		params: ToolCallParams | undefined,
	): Promise<void> => {
		const toolName = params?.name;
		if (!toolName) {
			sendError(id, { code: -32602, message: "tool name is required" });
			return;
		}

		if (!state.tools) {
			await getAgent();
		}
		const tool = state.tools?.find((entry) => entry.name === toolName);
		if (!tool) {
			sendError(id, { code: -32602, message: `unknown tool: ${toolName}` });
			return;
		}

		try {
			const result = await tool.executeRaw(
				JSON.stringify(params?.arguments ?? {}),
				createToolContext(),
			);
			const response: ToolCallResult = {
				ok: true,
				result: normalizeToolResult(result),
			};
			sendResult(id, response);
		} catch (error) {
			sendError(id, {
				code: -32000,
				message: `tool call failed: ${String(error)}`,
			});
		}
	};

	return {
		handleToolCall,
	};
};
