import type { ModelSpec } from "./registry";

export const GOOGLE_DEFAULT_MODEL = "gemini-4-hydrogen";
export const GOOGLE_MODELS: ModelSpec[] = [
	GOOGLE_DEFAULT_MODEL,
	"gemini-4-carbon",
	"gemini-4-argon",
].map((id) => ({
	id,
	provider: "google",
	...(id === GOOGLE_DEFAULT_MODEL ? { aliases: ["default"] } : {}),
	// Gemini 4 shares input, thinking and output in one context window.
	contextWindow: 1_048_576,
	maxInputTokens: 983_040,
	maxOutputTokens: 65_536,
	supportsTools: true,
	supportsVision: true,
	supportsReasoning: true,
}));
