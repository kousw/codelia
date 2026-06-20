import type { ModelSpec } from "./registry";

export const ZAI_DEFAULT_MODEL = "glm-5.2";

export const ZAI_MODELS: ModelSpec[] = [
	{
		id: ZAI_DEFAULT_MODEL,
		provider: "zai",
		aliases: ["default"],
		contextWindow: 1_000_000,
		maxInputTokens: 1_000_000,
		maxOutputTokens: 131_072,
		supportsTools: true,
		supportsReasoning: true,
		supportsJsonSchema: true,
	},
];
