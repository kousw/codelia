import type { ProviderName } from "@codelia/shared-types";
import type { ChatInvokeCompletion } from "../types/llm/invoke";
import type { BaseMessage } from "../types/llm/messages";
import type { ToolChoice, ToolDefinition } from "../types/llm/tools";
import type { ProviderFailureClassifier } from "./failures";
import type { LlmRetryPolicy } from "./retry";
import type { ImageTokenEstimate, ImageTokenInput } from "./image-policy";

export type { ProviderName } from "@codelia/shared-types";
export type { ImageTokenEstimate, ImageTokenInput } from "./image-policy";

/**
 * One provisional chunk of streamed model output. `index` numbers the streamed
 * blocks of one kind in this response, in order of their first delta. It is a
 * grouping key for provisional display, not a position in the completion.
 */
export type ChatStreamDelta = {
	kind: "text" | "reasoning";
	index: number;
	delta: string;
};

/** Per-attempt sink for streamed deltas. Providers that do not stream ignore it. */
export type ChatStreamDeltaSink = (delta: ChatStreamDelta) => void;

export type ChatInvokeInput = {
	messages: BaseMessage[];
	model?: string;
	tools?: ToolDefinition[] | null;
	toolChoice?: ToolChoice | null;
	signal?: AbortSignal;
	/** Optional, per-attempt. Absent means providers keep their non-delta path unchanged. */
	onDelta?: ChatStreamDeltaSink;
};

export type ChatInvokeContext = {
	sessionKey?: string;
	/** One user turn; distinct from a durable session key. */
	turnKey?: string;
	onProviderStatus?: (
		event: import("@codelia/shared-types").LlmStatusEvent,
	) => void;
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
	/** Endpoint-owned retry policy takes precedence over Agent defaults. */
	readonly retryPolicy?: Partial<LlmRetryPolicy>;
	/** Optional model-specific vision estimate; never a billing usage report. */
	estimateImageTokens?(image: ImageTokenInput): ImageTokenEstimate;

	onHistoryCompacted?(context?: ChatInvokeContext): void | Promise<void>;
}
