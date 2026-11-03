import type { ModelReasoningLevel } from "@codelia/shared-types";
import type { ModelSpec } from "./registry";

export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
export const DEEPSEEK_MODELS = [
	{
		id: DEEPSEEK_DEFAULT_MODEL,
		provider: "deepseek",
		aliases: ["default"],
		contextWindow: 1_000_000,
		maxInputTokens: 1_000_000,
		maxOutputTokens: 384_000,
		supportsTools: true,
		supportsReasoning: true,
		supportsJsonSchema: true,
		supportsVision: true,
		supportsFast: false,
	},
	{
		id: "deepseek-v4-pro",
		provider: "deepseek",
		contextWindow: 1_000_000,
		maxInputTokens: 1_000_000,
		maxOutputTokens: 384_000,
		supportsTools: true,
		supportsReasoning: true,
		supportsJsonSchema: true,
		supportsVision: false,
		supportsFast: false,
	},
] satisfies ModelSpec[];

/** DeepSeek documents medium/xhigh as aliases of high. */
export const resolveDeepSeekEffort = (
	requested: ModelReasoningLevel,
): "low" | "high" | "max" =>
	requested === "medium" || requested === "xhigh" ? "high" : requested;
