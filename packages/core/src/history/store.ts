import type { ChatInvokeInput } from "../llm/base";
import type {
	BaseMessage,
	ContentPart,
	SystemMessage,
	ToolMessage,
	UserMessage,
} from "../types/llm";
import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { ToolChoice, ToolDefinition } from "../types/llm/tools";

export interface HistoryAdapter {
	enqueueSystem(system?: SystemMessage): void;
	enqueueUserMessage(content: string | ContentPart[]): void;
	enqueueToolResult(message: ToolMessage): void;
	commitModelResponse(response: ChatInvokeCompletion): void;
	prepareInvokeInput(params: {
		tools?: ToolDefinition[] | null;
		toolChoice?: ToolChoice | null;
	}): ChatInvokeInput;
	getViewMessages(): BaseMessage[];
	replaceViewMessages(messages: BaseMessage[]): void;
}

export class MessageHistoryAdapter implements HistoryAdapter {
	private messages: BaseMessage[] = [];
	private hasSystem = false;

	enqueueSystem(system?: SystemMessage): void {
		if (system && !this.hasSystem) {
			this.messages.push(system);
			this.hasSystem = true;
		}
	}

	enqueueUserMessage(content: string | ContentPart[]): void {
		const message: UserMessage = {
			role: "user",
			content,
		};
		this.messages.push(message);
	}

	enqueueToolResult(message: ToolMessage): void {
		this.messages.push(message);
	}

	commitModelResponse(response: ChatInvokeCompletion): void {
		this.messages.push(...response.messages);
	}

	prepareInvokeInput(params: {
		tools?: ToolDefinition[] | null;
		toolChoice?: ToolChoice | null;
	}): ChatInvokeInput {
		return {
			messages: this.messages,
			tools: params.tools ?? null,
			toolChoice: params.toolChoice ?? null,
		};
	}

	getViewMessages(): BaseMessage[] {
		return this.messages;
	}

	replaceViewMessages(messages: BaseMessage[]): void {
		this.messages = messages;
		this.hasSystem = messages.some((message) => message.role === "system");
	}
}
