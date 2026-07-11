import type { ReasoningEffort } from "openai/resources/shared";

/**
 * Responses API reasoning values supported by Codelia models. The generated
 * OpenAI SDK type can lag newly released provider values such as `max`.
 */
export type ResponsesReasoningEffort = ReasoningEffort | "max";

export const toSdkReasoningEffort = (
	effort: ResponsesReasoningEffort | undefined,
): ReasoningEffort | undefined => effort as ReasoningEffort | undefined;
