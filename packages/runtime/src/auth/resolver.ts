import type { ResponsesProviderConfig } from "@codelia/config";
import { readEnvValue } from "../config";
import {
	requestUiConfirm,
	requestUiPick,
	requestUiPrompt,
} from "../rpc/ui-requests";
import type { RuntimeState } from "../runtime-state";
import {
	resolveOAuthBrowserMode,
	shouldAutoOpenOAuthBrowser,
} from "./oauth-utils";
import { createOpenAiDeviceCodeSession } from "./openai-device-code";
import type { OpenAiTokenResponse } from "./openai-oauth";
import {
	createOAuthSession,
	extractAccountId,
	openBrowser,
	refreshAccessToken,
} from "./openai-oauth";
import type { AuthFile, OAuthTokens, ProviderAuth } from "./store";
import { AuthStore } from "./store";

export const SUPPORTED_PROVIDERS = [
	"openai",
	"anthropic",
	"openrouter",
	"google",
	"deepseek",
	"moonshot",
	"zai",
	"xai",
] as const;
export type BuiltinSupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];
export type SupportedProvider = string;
export const configuredProviders = (
	providers?: Record<string, ResponsesProviderConfig>,
): string[] => [...SUPPORTED_PROVIDERS, ...Object.keys(providers ?? {})];

const API_KEY_ENV: Record<string, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	google: "GOOGLE_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	moonshot: "MOONSHOT_API_KEY",
	zai: "ZAI_API_KEY",
	xai: "XAI_API_KEY",
};

/** API-key environment variable for a provider (config endpoints use `api_key_env`). */
export const providerApiKeyEnvName = (
	provider: string,
	providers?: Record<string, ResponsesProviderConfig>,
): string | undefined =>
	providers && Object.hasOwn(providers, provider)
		? providers[provider].api_key_env
		: API_KEY_ENV[provider];

/** Reads the provider API key from the environment (Google also accepts GEMINI_API_KEY). */
export const readProviderEnvApiKey = (
	provider: string,
	providers?: Record<string, ResponsesProviderConfig>,
): string | undefined => {
	const name = providerApiKeyEnvName(provider, providers);
	return (
		(name ? readEnvValue(name) : undefined) ??
		(provider === "google" ? readEnvValue("GEMINI_API_KEY") : undefined)
	);
};

/** Sign-in methods runtime can perform for a provider. */
export const providerAuthMethods = (
	provider: string,
	providers?: Record<string, ResponsesProviderConfig>,
): Array<"api_key" | "oauth" | "device_code"> =>
	provider === "openai" && !(providers && Object.hasOwn(providers, provider))
		? ["oauth", "device_code", "api_key"]
		: ["api_key"];

/** Converts an OpenAI token response into the stored OAuth shape. */
export const toStoredOpenAiOAuth = (
	tokens: OpenAiTokenResponse,
): OAuthTokens => {
	const accountId = extractAccountId(tokens);
	return {
		access_token: tokens.access_token,
		refresh_token: tokens.refresh_token,
		expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		...(accountId ? { account_id: accountId } : {}),
	};
};

export class AuthResolver {
	private auth: AuthFile;
	private readonly store: AuthStore;
	private readonly log: (message: string) => void;
	private readonly state: RuntimeState;
	private readonly providers: Record<string, ResponsesProviderConfig>;
	private readonly availableProviders: string[];

	private constructor(
		state: RuntimeState,
		log: (message: string) => void,
		store: AuthStore,
		auth: AuthFile,
		providers: Record<string, ResponsesProviderConfig>,
	) {
		this.state = state;
		this.log = log;
		this.store = store;
		this.auth = auth;
		this.providers = providers;
		this.availableProviders = configuredProviders(providers);
	}

	static async create(
		state: RuntimeState,
		log: (message: string) => void,
		providers: Record<string, ResponsesProviderConfig> = {},
	): Promise<AuthResolver> {
		const store = new AuthStore();
		const auth = await store.load();
		return new AuthResolver(state, log, store, auth, providers);
	}

	hasAnyAvailableAuth(): boolean {
		return this.availableProviders.some((provider) => {
			if (this.auth.providers[provider]) return true;
			return Boolean(this.envApiKey(provider));
		});
	}

	async resolveProvider(preferred?: string | null): Promise<SupportedProvider> {
		const preferredProvider =
			preferred &&
			this.availableProviders.includes(preferred as SupportedProvider)
				? (preferred as SupportedProvider)
				: null;
		if (preferred && !preferredProvider)
			throw new Error(`Unsupported model.provider: ${preferred}`);
		if (preferredProvider) return preferredProvider;

		const providersWithAuth = this.availableProviders.filter(
			(provider) => !!this.auth.providers[provider],
		);
		if (providersWithAuth.length === 1) {
			return providersWithAuth[0];
		}

		const needsPick = providersWithAuth.length === 0;
		if (!needsPick) {
			return providersWithAuth[0] ?? "openai";
		}

		const supportsPick = !!this.state.uiCapabilities?.supports_pick;
		if (!supportsPick) {
			return "openai";
		}

		const result = await requestUiPick(this.state, {
			title: "Welcome! Choose your provider to get started.",
			items: this.availableProviders.map((provider) => ({
				id: provider,
				label: provider,
				detail:
					provider === "openai"
						? "OAuth (ChatGPT Plus/Pro) or API key"
						: provider === "openrouter"
							? "API key (OpenRouter)"
							: provider === "moonshot"
								? "API key (Moonshot)"
								: provider === "zai"
									? "API key (Z.ai)"
									: provider === "xai"
										? "API key (xAI)"
										: "API key",
			})),
			multi: false,
		});
		const choice = result?.ids?.[0];
		if (
			!choice ||
			!this.availableProviders.includes(choice as SupportedProvider)
		) {
			throw new Error("provider selection cancelled");
		}
		return choice as SupportedProvider;
	}

	async resolveProviderAuth(
		provider: SupportedProvider,
	): Promise<ProviderAuth> {
		if (!this.availableProviders.includes(provider))
			throw new Error(`Unsupported provider: ${provider}`);
		const existing = this.auth.providers[provider];
		if (existing) return existing;

		const envValue = this.envApiKey(provider);
		if (envValue) {
			const auth: ProviderAuth = { method: "api_key", api_key: envValue };
			await this.setProviderAuth(provider, auth);
			return auth;
		}

		if (provider === "openai") {
			return this.promptOpenAiAuth();
		}
		return this.promptApiKey(provider, this.getApiKeyPromptLabel(provider));
	}

	private envApiKey(provider: string): string | undefined {
		return readProviderEnvApiKey(provider, this.providers);
	}

	private getApiKeyPromptLabel(provider: SupportedProvider): string {
		switch (provider) {
			case "anthropic":
				return "Anthropic API key";
			case "openrouter":
				return "OpenRouter API key";
			case "deepseek":
				return "DeepSeek API key";
			case "google":
				return "Gemini Developer API key";
			case "moonshot":
				return "Moonshot API key";
			case "zai":
				return "Z.ai API key";
			case "xai":
				return "xAI API key";
			default:
				return `${provider} API key`;
		}
	}

	async getOpenAiAccessToken(): Promise<{ token: string; accountId?: string }> {
		const entry = this.auth.providers.openai;
		if (entry?.method !== "oauth") {
			throw new Error("OpenAI OAuth is not configured");
		}
		let oauth = entry.oauth;
		if (oauth.expires_at <= Date.now() + 60_000) {
			// Reload inside the shared auth-file queue: a sibling resolver or
			// another client may already have rotated the cached refresh token.
			oauth = await this.store.update(async (auth) => {
				const current = auth.providers.openai;
				if (current?.method !== "oauth") {
					throw new Error("OpenAI OAuth is not configured");
				}
				if (current.oauth.expires_at > Date.now() + 60_000) {
					return current.oauth;
				}
				this.log("refreshing OpenAI OAuth token");
				const tokens = await refreshAccessToken(current.oauth.refresh_token);
				const accountId = extractAccountId(tokens) ?? current.oauth.account_id;
				const refreshed = {
					access_token: tokens.access_token,
					refresh_token: tokens.refresh_token,
					expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					...(accountId ? { account_id: accountId } : {}),
				};
				auth.providers.openai = { method: "oauth", oauth: refreshed };
				return refreshed;
			});
			this.auth.providers.openai = { method: "oauth", oauth };
		}
		return { token: oauth.access_token, accountId: oauth.account_id };
	}

	private async promptOpenAiAuth(): Promise<ProviderAuth> {
		const supportsPick = !!this.state.uiCapabilities?.supports_pick;
		const supportsPrompt = !!this.state.uiCapabilities?.supports_prompt;
		if (!supportsPick || !supportsPrompt) {
			throw new Error("UI does not support auth prompts");
		}
		const prefersDeviceCode = resolveOAuthBrowserMode() === "manual";
		const pick = await requestUiPick(this.state, {
			title: "How would you like to connect OpenAI?",
			items: prefersDeviceCode
				? [
						{
							id: "device_code",
							label: "ChatGPT Plus/Pro (device code)",
							detail:
								"Best for SSH/headless terminals; no localhost callback needed",
						},
						{
							id: "oauth",
							label: "ChatGPT Plus/Pro (OAuth)",
							detail:
								"Browser sign-in with localhost callback or pasted callback URL",
						},
						{
							id: "api_key",
							label: "OpenAI API key",
							detail: "Use a standard OpenAI API key from platform settings",
						},
					]
				: [
						{
							id: "oauth",
							label: "ChatGPT Plus/Pro (OAuth)",
							detail: "Recommended for local browser sign-in",
						},
						{
							id: "device_code",
							label: "ChatGPT Plus/Pro (device code)",
							detail:
								"Best for SSH/headless terminals; no localhost callback needed",
						},
						{
							id: "api_key",
							label: "OpenAI API key",
							detail: "Use a standard OpenAI API key from platform settings",
						},
					],
			multi: false,
		});
		const method = pick?.ids?.[0];
		if (!method) {
			throw new Error("auth selection cancelled");
		}
		if (method === "api_key") {
			return this.promptApiKey("openai", "OpenAI API key");
		}
		if (method === "device_code") {
			return this.promptOpenAiDeviceCode();
		}
		if (method !== "oauth") {
			throw new Error("unknown auth method");
		}
		return this.promptOpenAiOAuth();
	}

	private async promptOpenAiDeviceCode(): Promise<ProviderAuth> {
		const supportsConfirm = !!this.state.uiCapabilities?.supports_confirm;
		if (!supportsConfirm) {
			throw new Error("UI does not support device code confirmation");
		}
		const session = await createOpenAiDeviceCodeSession();
		const shouldAutoOpen = shouldAutoOpenOAuthBrowser();
		const confirm = await requestUiConfirm(this.state, {
			title: "OpenAI device code",
			message: [
				"Open this link in a browser and sign in:",
				"",
				session.verificationUrl,
				"",
				"Then enter this one-time code (expires in 15 minutes):",
				"",
				session.userCode,
				"",
				"Device codes are a common phishing target. Never share this code.",
			].join("\n"),
			confirm_label: shouldAutoOpen ? "Open browser" : "Continue",
			cancel_label: "Cancel",
			allow_remember: false,
			allow_reason: false,
		});
		if (!confirm?.ok) {
			throw new Error("device code login cancelled");
		}
		if (shouldAutoOpen) {
			openBrowser(session.verificationUrl);
		}
		const tokens = await session.complete();
		const accountId = extractAccountId(tokens);
		const oauth: OAuthTokens = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
			...(accountId ? { account_id: accountId } : {}),
		};
		const auth: ProviderAuth = { method: "oauth", oauth };
		await this.setProviderAuth("openai", auth);
		return auth;
	}

	private async promptOpenAiOAuth(): Promise<ProviderAuth> {
		const supportsConfirm = !!this.state.uiCapabilities?.supports_confirm;
		const supportsPrompt = !!this.state.uiCapabilities?.supports_prompt;
		if (!supportsConfirm) {
			throw new Error("UI does not support OAuth confirmation");
		}
		const shouldAutoOpen = shouldAutoOpenOAuthBrowser();
		const canPasteCallback = !shouldAutoOpen && supportsPrompt;
		const session = await createOAuthSession({
			callbackMode: canPasteCallback ? "paste" : "server",
		});
		const messageLines = [
			shouldAutoOpen
				? "You're almost done. Open your browser to continue sign in."
				: canPasteCallback
					? "Open this URL in a browser to continue sign in. After the browser is redirected to localhost, copy the full URL from the address bar and paste it in the next step."
					: "Open this URL in a browser to continue sign in.",
			"",
			session.authUrl,
		];
		const confirm = await requestUiConfirm(this.state, {
			title: "OpenAI OAuth",
			message: messageLines.join("\n"),
			confirm_label: shouldAutoOpen ? "Open browser" : "I opened it",
			cancel_label: "Cancel",
			allow_remember: false,
			allow_reason: false,
		});
		if (!confirm?.ok) {
			session.stop();
			throw new Error("OAuth cancelled");
		}
		if (shouldAutoOpen) {
			openBrowser(session.authUrl);
		}
		let tokens: OpenAiTokenResponse;
		try {
			if (canPasteCallback) {
				const prompt = await requestUiPrompt(this.state, {
					title: "OpenAI OAuth callback",
					message:
						"After sign in completes, paste the full redirected URL from the browser address bar. You can also paste just code=...&state=....",
					multiline: false,
					secret: true,
				});
				const value = prompt?.value?.trim();
				if (!value) {
					throw new Error("OAuth cancelled");
				}
				tokens = await session.completeFromInput(value);
			} else {
				tokens = await session.waitForTokens();
			}
		} catch (err) {
			session.stop();
			throw err;
		}
		session.stop();
		const accountId = extractAccountId(tokens);
		const oauth: OAuthTokens = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
			...(accountId ? { account_id: accountId } : {}),
		};
		const auth: ProviderAuth = { method: "oauth", oauth };
		await this.setProviderAuth("openai", auth);
		return auth;
	}

	private async promptApiKey(
		provider: SupportedProvider,
		label: string,
	): Promise<ProviderAuth> {
		const supportsPrompt = !!this.state.uiCapabilities?.supports_prompt;
		if (!supportsPrompt) {
			throw new Error("UI does not support auth prompts");
		}
		const prompt = await requestUiPrompt(this.state, {
			title: label,
			message: `Paste your API key to continue. You can change it later with /logout ${provider}.`,
			secret: true,
		});
		const value = prompt?.value?.trim() ?? "";
		if (!value) {
			throw new Error("API key entry cancelled");
		}
		const auth: ProviderAuth = { method: "api_key", api_key: value };
		await this.setProviderAuth(provider, auth);
		return auth;
	}

	private async setProviderAuth(
		provider: SupportedProvider,
		auth: ProviderAuth,
	): Promise<void> {
		// Another provider may have been logged out since this resolver was created.
		this.auth = await this.store.update((latest) => {
			latest.providers[provider] = auth;
			return latest;
		});
	}
}
