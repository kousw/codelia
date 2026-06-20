import type { ModelSpec } from "./registry";

export const ZAI_DEFAULT_MODEL = "glm-5.2";
export const ZAI_REASONING_EFFORT_MODELS = new Set<string>(["glm-5.2"]);

const zaiModel = (
	id: string,
	limits: {
		contextWindow: number;
		maxOutputTokens: number;
		aliases?: string[];
	},
): ModelSpec => ({
	id,
	provider: "zai",
	aliases: limits.aliases,
	contextWindow: limits.contextWindow,
	maxInputTokens: limits.contextWindow,
	maxOutputTokens: limits.maxOutputTokens,
	supportsTools: true,
	supportsReasoning: true,
	supportsJsonSchema: true,
});

export const ZAI_MODELS: ModelSpec[] = [
	zaiModel(ZAI_DEFAULT_MODEL, {
		aliases: ["default"],
		contextWindow: 1_000_000,
		maxOutputTokens: 131_072,
	}),
	zaiModel("glm-5.1", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
	}),
	zaiModel("glm-5", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
	}),
	zaiModel("glm-5-turbo", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
	}),
	zaiModel("glm-4.7", {
		contextWindow: 200_000,
		maxOutputTokens: 131_072,
	}),
];
