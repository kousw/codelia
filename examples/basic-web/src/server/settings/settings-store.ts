import { promises as fs } from "node:fs";
import path from "node:path";
import { StoragePathServiceImpl } from "@codelia/storage";
import type { RuntimeModelSettings } from "../config/config";
import type { OpenAiOAuthTokens } from "../config/openai-oauth";

type Provider = "openai" | "anthropic";
type ReasoningEffort = "low" | "medium" | "high";

type PersistedSettings = {
	version: 1;
	provider?: Provider;
	model?: string;
	reasoning?: ReasoningEffort;
	openai_api_key?: string;
	openai_oauth?: OpenAiOAuthTokens;
	anthropic_api_key?: string;
	updated_at: string;
};

export type OAuthStateRecord = {
	provider: "openai";
	state: string;
	code_verifier: string;
	redirect_uri: string;
	expires_at: number;
};

export type PublicSettings = {
	provider?: Provider;
	model?: string;
	reasoning?: ReasoningEffort;
	openai_api_key_set: boolean;
	openai_api_key_preview?: string;
	openai_oauth_connected: boolean;
	openai_oauth_expires_at?: number;
	openai_oauth_account_id?: string;
	anthropic_api_key_set: boolean;
	anthropic_api_key_preview?: string;
	updated_at?: string;
};

export type SettingsPatch = {
	provider?: Provider;
	model?: string;
	reasoning?: ReasoningEffort;
	clear_reasoning?: boolean;
	openai_api_key?: string;
	clear_openai_oauth?: boolean;
	anthropic_api_key?: string;
	clear_openai_api_key?: boolean;
	clear_anthropic_api_key?: boolean;
};

export type OAuthStateConsumed = {
	code_verifier: string;
	redirect_uri: string;
};

export type SettingsStoreLike = {
	getPublicSettings(): Promise<PublicSettings>;
	getRuntimeSettings(): Promise<RuntimeModelSettings>;
	saveOpenAiOAuth(tokens: OpenAiOAuthTokens): Promise<PublicSettings>;
	patchSettings(patch: SettingsPatch): Promise<PublicSettings>;
	saveOAuthState(record: OAuthStateRecord): Promise<void>;
	consumeOAuthState(
		provider: "openai",
		state: string,
	): Promise<OAuthStateConsumed | null>;
	dispose?(): Promise<void> | void;
};

const SETTINGS_FILENAME = "basic-web.settings.json";

const keyPreview = (value: string): string => {
	if (value.length <= 8) return "*".repeat(Math.max(0, value.length));
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const sanitizeOptionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const sanitizeReasoning = (value: unknown): ReasoningEffort | undefined => {
	if (value === "low" || value === "medium" || value === "high") {
		return value;
	}
	return undefined;
};

const sanitizeProvider = (value: unknown): Provider | undefined => {
	if (value === "openai" || value === "anthropic") return value;
	return undefined;
};

const sanitizeOpenAiOAuth = (value: unknown): OpenAiOAuthTokens | undefined => {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<OpenAiOAuthTokens>;
	const accessToken = sanitizeOptionalString(candidate.access_token);
	const refreshToken = sanitizeOptionalString(candidate.refresh_token);
	const expiresAt =
		typeof candidate.expires_at === "number" &&
		Number.isFinite(candidate.expires_at)
			? candidate.expires_at
			: undefined;
	if (!accessToken || !refreshToken || !expiresAt) return undefined;
	const accountId = sanitizeOptionalString(candidate.account_id);
	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		expires_at: expiresAt,
		...(accountId ? { account_id: accountId } : {}),
	};
};

export class SettingsStore implements SettingsStoreLike {
	private readonly filePath: string;
	private readonly oauthStateMemory = new Map<string, OAuthStateRecord>();

	constructor() {
		const storage = new StoragePathServiceImpl();
		const paths = storage.resolvePaths();
		this.filePath = path.join(paths.configDir, SETTINGS_FILENAME);
	}

	private async loadRaw(): Promise<PersistedSettings> {
		try {
			const raw = await fs.readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as Partial<PersistedSettings> | null;
			if (!parsed || parsed.version !== 1) {
				throw new Error("invalid settings version");
			}
			return {
				version: 1,
				provider: sanitizeProvider(parsed.provider),
				model: sanitizeOptionalString(parsed.model),
				reasoning: sanitizeReasoning(parsed.reasoning),
				openai_api_key: sanitizeOptionalString(parsed.openai_api_key),
				openai_oauth: sanitizeOpenAiOAuth(parsed.openai_oauth),
				anthropic_api_key: sanitizeOptionalString(parsed.anthropic_api_key),
				updated_at:
					typeof parsed.updated_at === "string"
						? parsed.updated_at
						: new Date().toISOString(),
			};
		} catch {
			return {
				version: 1,
				updated_at: new Date().toISOString(),
			};
		}
	}

	private async saveRaw(next: PersistedSettings): Promise<void> {
		await fs.mkdir(path.dirname(this.filePath), { recursive: true });
		await fs.writeFile(this.filePath, JSON.stringify(next, null, 2), {
			mode: 0o600,
		});
		try {
			await fs.chmod(this.filePath, 0o600);
		} catch {
			// ignore chmod failure on unsupported FS
		}
	}

	async getPublicSettings(): Promise<PublicSettings> {
		const current = await this.loadRaw();
		return {
			provider: current.provider,
			model: current.model,
			reasoning: current.reasoning,
			openai_api_key_set: Boolean(current.openai_api_key),
			openai_api_key_preview: current.openai_api_key
				? keyPreview(current.openai_api_key)
				: undefined,
			openai_oauth_connected: Boolean(current.openai_oauth),
			openai_oauth_expires_at: current.openai_oauth?.expires_at,
			openai_oauth_account_id: current.openai_oauth?.account_id,
			anthropic_api_key_set: Boolean(current.anthropic_api_key),
			anthropic_api_key_preview: current.anthropic_api_key
				? keyPreview(current.anthropic_api_key)
				: undefined,
			updated_at: current.updated_at,
		};
	}

	async getRuntimeSettings(): Promise<RuntimeModelSettings> {
		const current = await this.loadRaw();
		return {
			provider: current.provider,
			model: current.model,
			reasoning: current.reasoning,
			openaiApiKey: current.openai_api_key,
			openaiOAuth: current.openai_oauth,
			anthropicApiKey: current.anthropic_api_key,
		};
	}

	async saveOpenAiOAuth(tokens: OpenAiOAuthTokens): Promise<PublicSettings> {
		const current = await this.loadRaw();
		const next: PersistedSettings = {
			...current,
			openai_oauth: sanitizeOpenAiOAuth(tokens),
			updated_at: new Date().toISOString(),
		};
		await this.saveRaw(next);
		return this.getPublicSettings();
	}

	async patchSettings(patch: SettingsPatch): Promise<PublicSettings> {
		const current = await this.loadRaw();
		const next: PersistedSettings = {
			...current,
			provider: patch.provider ?? current.provider,
			model:
				patch.model !== undefined
					? sanitizeOptionalString(patch.model)
					: current.model,
			reasoning:
				patch.reasoning !== undefined
					? sanitizeReasoning(patch.reasoning)
					: current.reasoning,
			openai_api_key:
				patch.openai_api_key !== undefined
					? sanitizeOptionalString(patch.openai_api_key)
					: current.openai_api_key,
			openai_oauth: current.openai_oauth,
			anthropic_api_key:
				patch.anthropic_api_key !== undefined
					? sanitizeOptionalString(patch.anthropic_api_key)
					: current.anthropic_api_key,
			updated_at: new Date().toISOString(),
		};

		if (patch.clear_reasoning) {
			next.reasoning = undefined;
		}
		if (patch.clear_openai_api_key) {
			next.openai_api_key = undefined;
		}
		if (patch.clear_openai_oauth) {
			next.openai_oauth = undefined;
		}
		if (patch.clear_anthropic_api_key) {
			next.anthropic_api_key = undefined;
		}

		await this.saveRaw(next);
		return this.getPublicSettings();
	}

	async saveOAuthState(record: OAuthStateRecord): Promise<void> {
		const key = `${record.provider}:${record.state}`;
		this.oauthStateMemory.set(key, record);
	}

	async consumeOAuthState(
		provider: "openai",
		state: string,
	): Promise<OAuthStateConsumed | null> {
		const key = `${provider}:${state}`;
		const record = this.oauthStateMemory.get(key);
		if (!record) return null;
		this.oauthStateMemory.delete(key);
		if (record.expires_at <= Date.now()) return null;
		return {
			code_verifier: record.code_verifier,
			redirect_uri: record.redirect_uri,
		};
	}

	dispose(): void {
		this.oauthStateMemory.clear();
	}
}
