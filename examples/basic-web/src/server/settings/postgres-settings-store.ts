import { SQL } from "bun";
import type { RuntimeModelSettings } from "../config/config";
import type { OpenAiOAuthTokens } from "../config/openai-oauth";
import type {
	OAuthStateConsumed,
	OAuthStateRecord,
	PublicSettings,
	SettingsPatch,
	SettingsStoreLike,
} from "./settings-store";

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

const SETTINGS_ROW_KEY = "basic_web_settings";
const SCHEMA_LOCK_ID = 6_204_202_601;

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

export class PostgresSettingsStore implements SettingsStoreLike {
	private readonly sql: SQL;
	private readonly ready: Promise<void>;

	constructor(databaseUrl: string) {
		this.sql = new SQL(databaseUrl);
		this.ready = this.initSchema();
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
		await this.ready;
		await this.sql`
			insert into oauth_state (
				provider,
				state,
				code_verifier,
				redirect_uri,
				expires_at
			) values (
				${record.provider},
				${record.state},
				${record.code_verifier},
				${record.redirect_uri},
				${record.expires_at}::bigint
			)
			on conflict (provider, state)
			do update set
				code_verifier = excluded.code_verifier,
				redirect_uri = excluded.redirect_uri,
				expires_at = excluded.expires_at
		`;
	}

	async consumeOAuthState(
		provider: "openai",
		state: string,
	): Promise<OAuthStateConsumed | null> {
		await this.ready;
		const rows = await this.sql<
			Array<{
				code_verifier: string;
				redirect_uri: string;
			}>
		>`
			delete from oauth_state
			where provider = ${provider}
				and state = ${state}
				and expires_at > extract(epoch from now()) * 1000
			returning code_verifier, redirect_uri
		`;
		const row = rows[0];
		if (!row) return null;
		return {
			code_verifier: row.code_verifier,
			redirect_uri: row.redirect_uri,
		};
	}

	async dispose(): Promise<void> {
		await this.sql.close().catch(() => {});
	}

	private async loadRaw(): Promise<PersistedSettings> {
		await this.ready;
		const rows = await this.sql<Array<{ value_json: unknown }>>`
			select value_json
			from app_settings
			where key = ${SETTINGS_ROW_KEY}
			limit 1
		`;
		const row = rows[0];
		let parsed = row?.value_json as
			| Partial<PersistedSettings>
			| string
			| undefined;
		if (typeof parsed === "string") {
			try {
				parsed = JSON.parse(parsed) as Partial<PersistedSettings>;
			} catch {
				parsed = undefined;
			}
		}
		if (!parsed || parsed.version !== 1) {
			return {
				version: 1,
				updated_at: new Date().toISOString(),
			};
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
	}

	private async saveRaw(next: PersistedSettings): Promise<void> {
		await this.ready;
		await this.sql`
			insert into app_settings (key, value_json, updated_at)
			values (
				${SETTINGS_ROW_KEY},
				${JSON.stringify(next)}::jsonb,
				now()
			)
			on conflict (key)
			do update set
				value_json = excluded.value_json,
				updated_at = excluded.updated_at
		`;
	}

	private async initSchema(): Promise<void> {
		await this.sql`select pg_advisory_lock(${SCHEMA_LOCK_ID})`;
		try {
			await this.sql`
				create table if not exists app_settings (
					key text primary key,
					value_json jsonb not null,
					updated_at timestamptz not null default now()
				)
			`;
			await this.sql`
				create table if not exists oauth_state (
					provider text not null,
					state text not null,
					code_verifier text not null,
					redirect_uri text not null,
					expires_at bigint not null,
					created_at timestamptz not null default now(),
					primary key (provider, state)
				)
			`;
			await this.sql`
				create index if not exists oauth_state_expiry_idx
				on oauth_state(provider, expires_at)
			`;
			await this.sql`
				delete from oauth_state
				where expires_at <= extract(epoch from now()) * 1000
			`;
		} finally {
			await this.sql`select pg_advisory_unlock(${SCHEMA_LOCK_ID})`;
		}
	}
}
