import type { ModelSpec } from "./registry";

export const GOOGLE_DEFAULT_MODEL = "gemini-3.8-flash";
export const GOOGLE_MODELS: ModelSpec[] = [
	...(["gemini-4-carbon", "gemini-4-hydrogen"] as const).map(
		(id): ModelSpec => ({
			id,
			provider: "google",
			contextWindow: 1_048_576,
			// Gemini 4 shares input, thinking and output in one context window.
			maxInputTokens: 983_040,
			maxOutputTokens: 65_536,
			supportsTools: true,
			supportsVision: true,
			supportsReasoning: true,
		}),
	),
	{
		id: "gemini-4-argon",
		provider: "google",
		contextWindow: 1_048_576,
		maxInputTokens: 983_040,
		maxOutputTokens: 65_536,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
	},
	{
		id: GOOGLE_DEFAULT_MODEL,
		provider: "google",
		aliases: ["default"],
		contextWindow: 1_048_576,
		maxInputTokens: 1_048_576,
		maxOutputTokens: 65_536,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
	},
	{
		id: "gemini-3.5-flash-lite",
		provider: "google",
		contextWindow: 1_048_576,
		maxInputTokens: 1_048_576,
		maxOutputTokens: 65_536,
		supportsTools: true,
		supportsVision: true,
		supportsReasoning: true,
	},
];
