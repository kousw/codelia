import {
	OPENAI_IMAGE_MODELS,
	OPENAI_CODEX_IMAGE_MODELS,
	type ImageGenerationConfig,
} from "@codelia/config";
import type { ProviderAuth } from "../auth/store";
import { AuthStore } from "../auth/store";
import { OPENAI_OAUTH_BASE_URL } from "../auth/openai-oauth";
import { ImageGenerationError } from "./http";

type ImageRouteBase = {
	model: string;
	endpoint: string;
	options: Record<string, string>;
};
export type CodexImageToken = { token: string; accountId?: string };
export type ImageRoute = ImageRouteBase &
	(
		| { authMode: "api_key"; provider: "openai" | "openrouter"; apiKey: string }
		| {
				authMode: "codex_oauth";
				provider: "openai";
				apiKey?: never;
				accountId?: string;
				getAccessToken: () => Promise<CodexImageToken>;
		  }
	);
export type ImageChatConnection = {
	provider: string;
	auth: ProviderAuth;
	getOpenAiAccessToken?: () => Promise<CodexImageToken>;
};
export type ImageAuthSource = {
	storedKey: (provider: "openai" | "openrouter") => Promise<string | undefined>;
	env: (name: string) => string | undefined;
};
export const localImageAuth: ImageAuthSource = {
	storedKey: async (provider) => {
		const auth = (await new AuthStore().load()).providers[provider];
		return auth?.method === "api_key" ? auth.api_key : undefined;
	},
	env: (name) => process.env[name]?.trim() || undefined,
};

export async function resolveImageRoute(
	config: ImageGenerationConfig,
	auth: ImageAuthSource,
	chat?: ImageChatConnection,
): Promise<ImageRoute | null> {
	if (config.mode === "off") return null;
	let provider: "openai" | "openrouter";
	let model: string;
	let apiKey: string | undefined;
	if (config.mode === "builtin") {
		if (chat?.provider !== "openai")
			throw new ImageGenerationError(
				"builtin unavailable: select an OpenAI conversation connection and sign in first; no other provider or authentication route was selected.",
			);
		if (chat.auth.method === "oauth") {
			const oauth = chat.auth.oauth;
			if (!oauth.access_token.trim())
				throw new ImageGenerationError(
					"Codex OAuth login is missing; sign in to OpenAI again. An API key is not required.",
				);
			const o = config.provider_options?.openai;
			return {
				authMode: "codex_oauth",
				provider: "openai",
				model: o?.model ?? OPENAI_CODEX_IMAGE_MODELS[0],
				endpoint: `${OPENAI_OAUTH_BASE_URL}/images/generations`,
				options: {
					...(o?.quality ? { quality: o.quality } : {}),
					...(o?.size ? { size: o.size } : {}),
				},
				...(oauth.account_id ? { accountId: oauth.account_id } : {}),
				getAccessToken:
					chat.getOpenAiAccessToken ??
					(async () => {
						if (oauth.expires_at <= Date.now() + 60_000)
							throw new ImageGenerationError(
								"Codex OAuth refresh is unavailable; sign in to OpenAI again. An API key is not required.",
							);
						return { token: oauth.access_token, accountId: oauth.account_id };
					}),
			};
		}
		if (auth.env("OPENAI_BASE_URL"))
			throw new ImageGenerationError(
				"builtin unavailable: the API-key conversation uses an unsupported base URL override; no endpoint fallback was attempted.",
			);
		provider = "openai";
		model = config.provider_options?.openai?.model ?? OPENAI_IMAGE_MODELS[0];
		if (!(OPENAI_IMAGE_MODELS as readonly string[]).includes(model))
			throw new ImageGenerationError(
				"This selected builtin image model is only configured for Codex OAuth; select an API image model explicitly.",
			);
		apiKey = chat.auth.api_key;
	} else {
		provider = config.provider;
		model = config.model;
		apiKey = config.api_key_env
			? auth.env(config.api_key_env)
			: (await auth.storedKey(provider)) ||
				auth.env(
					provider === "openai" ? "OPENAI_API_KEY" : "OPENROUTER_API_KEY",
				);
	}
	if (!apiKey?.trim())
		throw new ImageGenerationError(
			"missing_api_key: set the selected runtime API-key environment variable (OPENAI_API_KEY / OPENROUTER_API_KEY by default). Chat OAuth is preserved and never used for custom images.",
		);
	const options: Record<string, string> = {};
	if (provider === "openai") {
		const o = config.provider_options?.openai;
		if (o?.quality) options.quality = o.quality;
		if (o?.size) options.size = o.size;
		return {
			authMode: "api_key",
			provider,
			model,
			apiKey,
			endpoint: "https://api.openai.com/v1/images/generations",
			options,
		};
	}
	const o = config.provider_options?.openrouter;
	if (!o?.endpoint)
		throw new ImageGenerationError(
			"Select an OpenRouter image endpoint with /image-model; automatic endpoint fallback is disabled.",
		);
	if (o.quality) options.quality = o.quality;
	if (o.resolution) options.resolution = o.resolution;
	if (o.aspect_ratio) options.aspect_ratio = o.aspect_ratio;
	return {
		authMode: "api_key",
		provider,
		model,
		apiKey,
		endpoint: o.endpoint,
		options,
	};
}
