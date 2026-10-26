import type { ModelSpec } from "./registry";

export const MOONSHOT_DEFAULT_MODEL = "kimi-k3";
export const MOONSHOT_K3_1_MODELS = new Set<string>([
	"kimi-k3.1-pro",
	"kimi-k3.1-pro-highspeed",
]);

export const MOONSHOT_MODELS: ModelSpec[] = [
	...Array.from(
		MOONSHOT_K3_1_MODELS,
		(id): ModelSpec => ({
			id,
			provider: "moonshot",
			contextWindow: 1_048_576,
			maxInputTokens: 1_048_576,
			maxOutputTokens: 1_048_576,
			supportsTools: true,
			supportsVision: true,
			supportsReasoning: true,
			supportsJsonSchema: true,
		}),
	),
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
