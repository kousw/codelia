import type { ModelSpec } from "./registry";

export const XAI_DEFAULT_MODEL = "grok-4.5";
export const XAI_DEFAULT_REASONING_EFFORT = "high" as const;

export const XAI_MODELS: ModelSpec[] = [
	{
		id: XAI_DEFAULT_MODEL,
		provider: "xai",
		aliases: ["grok-4.5-latest", "grok-build-latest"],
		contextWindow: 500_000,
		maxInputTokens: 200_000,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		supportsJsonSchema: true,
	},
];
