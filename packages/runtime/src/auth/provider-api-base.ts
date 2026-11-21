import { readEnvValue } from "../config";

const bases: Record<string, { official: string; env?: string }> = {
	openai: { official: "https://api.openai.com/v1", env: "OPENAI_BASE_URL" },
	anthropic: {
		official: "https://api.anthropic.com",
		env: "ANTHROPIC_BASE_URL",
	},
	google: {
		official: "https://generativelanguage.googleapis.com",
		env: "GOOGLE_GEMINI_BASE_URL",
	},
	deepseek: { official: "https://api.deepseek.com" },
	xai: { official: "https://api.x.ai/v1", env: "XAI_BASE_URL" },
	moonshot: {
		official: "https://api.moonshot.ai/v1",
		env: "MOONSHOT_BASE_URL",
	},
	zai: { official: "https://api.z.ai/api/paas/v4", env: "ZAI_BASE_URL" },
	openrouter: { official: "https://openrouter.ai/api/v1" },
};

export const builtinApiKeyBase = (provider: string): string | undefined => {
	const base = Object.hasOwn(bases, provider) ? bases[provider] : undefined;
	if (!base) return undefined;
	// The native SDK may choose a different auth/endpoint family in these modes.
	if (
		provider === "google" &&
		(
			readEnvValue("GOOGLE_GENAI_USE_ENTERPRISE") ??
			readEnvValue("GOOGLE_GENAI_USE_VERTEXAI")
		)?.toLowerCase() === "true"
	)
		return "vertex";
	if (
		provider === "anthropic" &&
		(readEnvValue("ANTHROPIC_AUTH_TOKEN") ||
			readEnvValue("ANTHROPIC_CUSTOM_HEADERS"))
	)
		return "anthropic-custom-auth";
	return ((base.env && readEnvValue(base.env)) || base.official).replace(
		/\/+$/u,
		"",
	);
};

export const isOfficialApiKeyBase = (
	provider: string,
	base?: string,
): boolean =>
	Object.hasOwn(bases, provider) && base === bases[provider].official;
