import type { ModelSpec } from "./registry";

export const MOONSHOT_DEFAULT_MODEL = "kimi-k3";

export const MOONSHOT_MODELS: ModelSpec[] = [
	{
		id: MOONSHOT_DEFAULT_MODEL,
		provider: "moonshot",
		aliases: ["default"],
		contextWindow: 1_048_576,
		maxInputTokens: 1_048_576,
		maxOutputTokens: 1_048_576,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
		supportsJsonSchema: true,
	},
];
