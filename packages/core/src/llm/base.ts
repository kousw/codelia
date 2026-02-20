import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { BaseMessage } from "../types/llm/messages";
import type { ToolChoice, ToolDefinition } from "../types/llm/tools";

export type ProviderName = "openai" | "anthropic" | "google";

export type ChatInvokeInput = {
	messages: BaseMessage[];
	model?: string;
	tools?: ToolDefinition[] | null;
	toolChoice?: ToolChoice | null;
	signal?: AbortSignal;
};

export type ChatInvokeContext = {
	sessionKey?: string;
};

export interface BaseChatModel<
	P extends ProviderName = ProviderName,
	O = unknown,
> {
	readonly provider: P;
	readonly model: string;

	ainvoke(
		input: ChatInvokeInput & { options?: O },
		context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion>;
}
