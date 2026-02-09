import { promises as fs } from "node:fs";
import path from "node:path";
import { configRegistry } from "@codelia/config";
import { loadConfig } from "@codelia/config-loader";
import {
	applyModelMetadata,
	type BaseChatModel,
	ChatAnthropic,
	ChatOpenAI,
	DEFAULT_MODEL_REGISTRY,
	getDefaultSystemPromptPath,
	type ModelRegistry,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import { StoragePathServiceImpl } from "@codelia/storage";
import {
	extractAccountId,
	OPENAI_OAUTH_BASE_URL,
	type OpenAiOAuthTokens,
	refreshAccessToken,
} from "./openai-oauth";

const DEFAULT_SYSTEM_PROMPT = "You are a coding assistant.";

export type RuntimeModelSettings = {
	provider?: "openai" | "anthropic";
	model?: string;
	reasoning?: "low" | "medium" | "high";
	openaiApiKey?: string;
	openaiOAuth?: OpenAiOAuthTokens;
	onOpenAiOAuthRefresh?: (oauth: OpenAiOAuthTokens) => Promise<void> | void;
	anthropicApiKey?: string;
};

const readEnvValue = (key: string): string | undefined => {
	const value = process.env[key];
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
};

const resolveConfigPath = (): string => {
	const envPath = readEnvValue("CODELIA_CONFIG_PATH");
	if (envPath) return path.resolve(envPath);
	const storage = new StoragePathServiceImpl();
	return storage.resolvePaths().configFile;
};

export const resolveModelConfig = async (): Promise<{
	provider?: string;
	name?: string;
	reasoning?: string;
}> => {
	const configPath = resolveConfigPath();
	try {
		const config = await loadConfig(configPath);
		const effective = configRegistry.resolve([config]);
		return {
			provider: effective.model?.provider,
			name: effective.model?.name,
			reasoning: effective.model?.reasoning,
		};
	} catch {
		return {};
	}
};

const resolveReasoningEffort = (
	value?: string,
): "low" | "medium" | "high" | undefined => {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "low" ||
		normalized === "medium" ||
		normalized === "high"
	) {
		return normalized;
	}
	return undefined;
};

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const buildOpenAiClientOptions = (
	settings?: RuntimeModelSettings,
): Record<string, unknown> => {
	const oauth = settings?.openaiOAuth;
	if (!oauth) {
		const apiKey = settings?.openaiApiKey ?? readEnvValue("OPENAI_API_KEY");
		if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");
		return { apiKey };
	}

	let current = oauth;
	let accountId = oauth.account_id;
	const persistRefreshedOAuth = settings?.onOpenAiOAuthRefresh;
	const enableDebugHttp = envTruthy(process.env.CODELIA_DEBUG);

	const apiKey = async () => {
		if (current.expires_at <= Date.now() + 60_000) {
			const tokens = await refreshAccessToken(current.refresh_token);
			const refreshedAccountId = extractAccountId(tokens) ?? accountId;
			current = {
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				...(refreshedAccountId ? { account_id: refreshedAccountId } : {}),
			};
			accountId = refreshedAccountId;
			await persistRefreshedOAuth?.(current);
		}
		return current.access_token;
	};

	const fetchWithAccount = Object.assign(
		async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
			const headers = new Headers(init?.headers ?? {});
			if (accountId) {
				headers.set("ChatGPT-Account-Id", accountId);
			}
			const nextInit = init ? { ...init, headers } : { headers };
			const response = await fetch(input, nextInit);
			if (enableDebugHttp && !response.ok) {
				const requestId =
					response.headers.get("x-request-id") ??
					response.headers.get("cf-ray") ??
					"-";
				console.error(
					`[openai-oauth] status=${response.status} request_id=${requestId}`,
				);
			}
			return response;
		},
		{ preconnect: fetch.preconnect },
	) as typeof fetch;

	return {
		apiKey,
		baseURL: OPENAI_OAUTH_BASE_URL,
		fetch: fetchWithAccount,
	};
};

export const loadSystemPrompt = async (workingDir: string): Promise<string> => {
	const promptPath = process.env.CODELIA_SYSTEM_PROMPT_PATH
		? path.resolve(process.env.CODELIA_SYSTEM_PROMPT_PATH)
		: getDefaultSystemPromptPath();
	try {
		const raw = await fs.readFile(promptPath, "utf8");
		const trimmed = raw.trim();
		if (!trimmed) {
			return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
		}
		return trimmed.includes("{{working_dir}}")
			? trimmed.replaceAll("{{working_dir}}", workingDir)
			: `${trimmed}\n\nWorking directory: ${workingDir}`;
	} catch {
		return `${DEFAULT_SYSTEM_PROMPT}\nWorking directory: ${workingDir}`;
	}
};

const buildModelRegistry = async (
	llm: BaseChatModel,
): Promise<ModelRegistry> => {
	const metadataService = new ModelMetadataServiceImpl({
		storagePathService: new StoragePathServiceImpl(),
	});
	const entries = await metadataService.getAllModelEntries();
	const providerEntries = entries[llm.provider];
	const directEntry = providerEntries?.[llm.model];
	const fullIdEntry = providerEntries?.[`${llm.provider}/${llm.model}`];
	if (!directEntry && !fullIdEntry) {
		throw new Error(
			`Model metadata not found for ${llm.provider}/${llm.model}`,
		);
	}
	return applyModelMetadata(DEFAULT_MODEL_REGISTRY, { models: entries });
};

export const createLLM = async (): Promise<{
	llm: BaseChatModel;
	modelRegistry: ModelRegistry;
}> => {
	const modelConfig = await resolveModelConfig();
	const provider = modelConfig.provider ?? "openai";
	let llm: BaseChatModel;
	switch (provider) {
		case "openai": {
			const reasoningEffort = resolveReasoningEffort(modelConfig.reasoning);
			llm = new ChatOpenAI({
				clientOptions: buildOpenAiClientOptions(),
				...(modelConfig.name ? { model: modelConfig.name } : {}),
				...(reasoningEffort ? { reasoningEffort } : {}),
			});
			break;
		}
		case "anthropic": {
			const apiKey = readEnvValue("ANTHROPIC_API_KEY");
			if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
			llm = new ChatAnthropic({
				clientOptions: { apiKey },
				...(modelConfig.name ? { model: modelConfig.name } : {}),
			});
			break;
		}
		default:
			throw new Error(`Unsupported model.provider: ${provider}`);
	}
	const modelRegistry = await buildModelRegistry(llm);
	return { llm, modelRegistry };
};

export const createLLMWithSettings = async (
	settings?: RuntimeModelSettings,
): Promise<{
	llm: BaseChatModel;
	modelRegistry: ModelRegistry;
}> => {
	const config = await resolveModelConfig();
	const provider = settings?.provider ?? config.provider ?? "openai";
	const model = settings?.model ?? config.name;
	const reasoning =
		settings?.reasoning ?? resolveReasoningEffort(config.reasoning);
	let llm: BaseChatModel;
	switch (provider) {
		case "openai": {
			llm = new ChatOpenAI({
				clientOptions: buildOpenAiClientOptions(settings),
				...(model ? { model } : {}),
				...(reasoning ? { reasoningEffort: reasoning } : {}),
			});
			break;
		}
		case "anthropic": {
			const apiKey =
				settings?.anthropicApiKey ?? readEnvValue("ANTHROPIC_API_KEY");
			if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
			llm = new ChatAnthropic({
				clientOptions: { apiKey },
				...(model ? { model } : {}),
			});
			break;
		}
		default:
			throw new Error(`Unsupported model.provider: ${provider}`);
	}
	const modelRegistry = await buildModelRegistry(llm);
	return { llm, modelRegistry };
};
