import { readEnvValue } from "../config";
import {
	requestUiConfirm,
	requestUiPick,
	requestUiPrompt,
} from "../rpc/ui-requests";
import type { RuntimeState } from "../runtime-state";
import type { OpenAiTokenResponse } from "./openai-oauth";
import {
	createOAuthSession,
	extractAccountId,
	openBrowser,
	refreshAccessToken,
} from "./openai-oauth";
import type { AuthFile, OAuthTokens, ProviderAuth } from "./store";
import { AuthStore } from "./store";

const SUPPORTED_PROVIDERS = ["openai", "anthropic"] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const API_KEY_ENV: Record<SupportedProvider, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
};

export class AuthResolver {
	private auth: AuthFile;
	private readonly store: AuthStore;
	private readonly log: (message: string) => void;
	private readonly state: RuntimeState;

	private constructor(
		state: RuntimeState,
		log: (message: string) => void,
		store: AuthStore,
		auth: AuthFile,
	) {
		this.state = state;
		this.log = log;
		this.store = store;
		this.auth = auth;
	}

	static async create(
		state: RuntimeState,
		log: (message: string) => void,
	): Promise<AuthResolver> {
		const store = new AuthStore();
		const auth = await store.load();
		return new AuthResolver(state, log, store, auth);
	}

	async resolveProvider(preferred?: string | null): Promise<SupportedProvider> {
		const preferredProvider =
			preferred && SUPPORTED_PROVIDERS.includes(preferred as SupportedProvider)
				? (preferred as SupportedProvider)
				: null;
		if (preferredProvider) return preferredProvider;

		const providersWithAuth = SUPPORTED_PROVIDERS.filter(
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
			title: "Select provider",
			items: SUPPORTED_PROVIDERS.map((provider) => ({
				id: provider,
				label: provider,
			})),
			multi: false,
		});
		const choice = result?.ids?.[0];
		if (!choice || !SUPPORTED_PROVIDERS.includes(choice as SupportedProvider)) {
			throw new Error("provider selection cancelled");
		}
		return choice as SupportedProvider;
	}

	async resolveProviderAuth(
		provider: SupportedProvider,
	): Promise<ProviderAuth> {
		const existing = this.auth.providers[provider];
		if (existing) return existing;

		const envKey = API_KEY_ENV[provider];
		const envValue = readEnvValue(envKey);
		if (envValue) {
			const auth: ProviderAuth = { method: "api_key", api_key: envValue };
			await this.setProviderAuth(provider, auth);
			return auth;
		}

		if (provider === "openai") {
			return this.promptOpenAiAuth();
		}
		return this.promptApiKey(provider, "Anthropic API key");
	}

	async getOpenAiAccessToken(): Promise<{ token: string; accountId?: string }> {
		const entry = this.auth.providers.openai;
		if (!entry || entry.method !== "oauth") {
			throw new Error("OpenAI OAuth is not configured");
		}
		let oauth = entry.oauth;
		if (oauth.expires_at <= Date.now() + 60_000) {
			this.log("refreshing OpenAI OAuth token");
			const tokens = await refreshAccessToken(oauth.refresh_token);
			const accountId = extractAccountId(tokens) ?? oauth.account_id;
			oauth = {
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				...(accountId ? { account_id: accountId } : {}),
			};
			await this.setProviderAuth("openai", { method: "oauth", oauth });
		}
		return { token: oauth.access_token, accountId: oauth.account_id };
	}

	private async promptOpenAiAuth(): Promise<ProviderAuth> {
		const supportsPick = !!this.state.uiCapabilities?.supports_pick;
		const supportsPrompt = !!this.state.uiCapabilities?.supports_prompt;
		if (!supportsPick || !supportsPrompt) {
			throw new Error("UI does not support auth prompts");
		}
		const pick = await requestUiPick(this.state, {
			title: "OpenAI auth method",
			items: [
				{ id: "oauth", label: "ChatGPT Plus/Pro (OAuth)" },
				{ id: "api_key", label: "Manually enter API key" },
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
		if (method !== "oauth") {
			throw new Error("unknown auth method");
		}
		return this.promptOpenAiOAuth();
	}

	private async promptOpenAiOAuth(): Promise<ProviderAuth> {
		const supportsConfirm = !!this.state.uiCapabilities?.supports_confirm;
		if (!supportsConfirm) {
			throw new Error("UI does not support OAuth confirmation");
		}
		const session = await createOAuthSession();
		const confirm = await requestUiConfirm(this.state, {
			title: "OpenAI OAuth",
			message: `Open your browser to authenticate.\n\n${session.authUrl}`,
			confirm_label: "Open browser",
			cancel_label: "Cancel",
			allow_remember: false,
			allow_reason: false,
		});
		if (!confirm?.ok) {
			session.stop();
			throw new Error("OAuth cancelled");
		}
		openBrowser(session.authUrl);
		let tokens: OpenAiTokenResponse;
		try {
			tokens = await session.waitForTokens();
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
			message: "Enter the API key.",
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
		this.auth = {
			...this.auth,
			providers: { ...this.auth.providers, [provider]: auth },
		};
		await this.store.save(this.auth);
	}
}
