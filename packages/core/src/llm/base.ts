import type { ProviderName } from "@codelia/shared-types";
import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { BaseMessage } from "../types/llm/messages";
import type { ToolChoice, ToolDefinition } from "../types/llm/tools";
import type { ProviderFailureClassifier } from "./failures";

export type { ProviderName } from "@codelia/shared-types";

export type ChatInvokeInput = {
	messages: BaseMessage[];
	model?: string;
	tools?: ToolDefinition[] | null;
	toolChoice?: ToolChoice | null;
	signal?: AbortSignal;
};

export type ChatInvokeContext = {
	sessionKey?: string;
	/** Await every delta to preserve bounded backpressure; canonical completion is authoritative. */
	onTextDelta?: (text: string) => Promise<void>;
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

	classifyFailure?: ProviderFailureClassifier;

	onHistoryCompacted?(context?: ChatInvokeContext): void | Promise<void>;
}
