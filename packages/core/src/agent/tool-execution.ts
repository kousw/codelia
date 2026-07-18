import type { DependencyKey, ToolContext } from "../tools/context";
import { TaskComplete } from "../tools/done";
import type { Tool, ToolExecution } from "../tools/tool";
import type {
	ContentPart,
	ToolCall,
	ToolMessage,
	ToolResult,
} from "../types/llm";
import type { ToolPermissionHook } from "../types/permissions";

export type ExecuteToolCallInput = {
	toolCall: ToolCall;
	tools: Tool[];
	signal?: AbortSignal;
	canExecuteTool?: ToolPermissionHook;
};

const toolResultToContent = (result: ToolResult): string | ContentPart[] => {
	if (result.type === "text") return result.text;
	if (result.type === "parts") return result.parts;
	try {
		return JSON.stringify(result.value);
	} catch {
		return String(result.value);
	}
};

const createToolContext = (signal?: AbortSignal): ToolContext => {
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
		signal,
		now: () => new Date(),
	};
};

export const executeToolCall = async ({
	toolCall,
	tools,
	signal,
	canExecuteTool,
}: ExecuteToolCallInput): Promise<ToolExecution> => {
	const toolName = toolCall.function.name;
	const tool = tools.find((candidate) => candidate.name === toolName);
	if (!tool) {
		return {
			message: {
				role: "tool",
				tool_call_id: toolCall.id,
				tool_name: toolName,
				content: `Error: Unknown tool '${toolName}'`,
				is_error: true,
			} satisfies ToolMessage,
		} satisfies ToolExecution;
	}

	if (canExecuteTool) {
		try {
			const decision = await canExecuteTool(
				toolCall,
				toolCall.function.arguments,
				createToolContext(signal),
			);
			if (decision.decision === "deny") {
				const deniedContent = `Permission denied${
					decision.reason ? `: ${decision.reason}` : ""
				}`;
				return {
					message: {
						role: "tool",
						tool_call_id: toolCall.id,
						tool_name: toolName,
						content: deniedContent,
						is_error: true,
					} satisfies ToolMessage,
					...(decision.stop_turn
						? {
								done: true,
								finalMessage:
									"Permission request was denied. Turn stopped. Please send your next input to continue.",
							}
						: {}),
				} satisfies ToolExecution;
			}
		} catch (error) {
			return {
				message: {
					role: "tool",
					tool_call_id: toolCall.id,
					tool_name: toolName,
					content: `Permission check failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
					is_error: true,
				} satisfies ToolMessage,
			} satisfies ToolExecution;
		}
	}

	try {
		const result = await tool.executeRaw(
			toolCall.function.arguments,
			createToolContext(signal),
		);

		return {
			message: {
				role: "tool",
				tool_call_id: toolCall.id,
				tool_name: toolName,
				content: toolResultToContent(result),
			} satisfies ToolMessage,
		} satisfies ToolExecution;
	} catch (error) {
		if (error instanceof TaskComplete) {
			return {
				message: {
					role: "tool",
					tool_call_id: toolCall.id,
					tool_name: toolName,
					content: "Task complete",
				} satisfies ToolMessage,
				done: true,
				finalMessage: error.finalMessage,
			} satisfies ToolExecution;
		}
		return {
			message: {
				role: "tool",
				tool_call_id: toolCall.id,
				tool_name: toolName,
				content: `Error: ${error instanceof Error ? error.message : String(error)}`,
				is_error: true,
			} satisfies ToolMessage,
		} satisfies ToolExecution;
	}
};
