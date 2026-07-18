import type { BaseChatModel } from "@codelia/core";
import {
	ANTHROPIC_DEFAULT_MODEL,
	ChatAnthropic,
	ChatMoonshot,
	ChatOpenAI,
	ChatOpenRouter,
	ChatXai,
	ChatZai,
	DEFAULT_MODEL_REGISTRY,
	MOONSHOT_DEFAULT_MODEL,
	type ModelEntry,
	OPENAI_DEFAULT_MODEL,
	resolveModel,
	resolveProviderModelId,
	XAI_DEFAULT_MODEL,
	ZAI_DEFAULT_MODEL,
	ZAI_REASONING_EFFORT_MODELS,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import { StoragePathServiceImpl } from "@codelia/storage";
import { OPENAI_OAUTH_BASE_URL } from "./auth/openai-oauth";
import type { SupportedProvider } from "./auth/resolver";
import type { ProviderAuth } from "./auth/store";
import {
	type ResolvedModelConfig,
	readEnvValue,
	resolveReasoningEffort,
	resolveTextVerbosity,
} from "./config";
import { resolveFastMode } from "./model-fast";
import {
	resolveAnthropicMaxTokens,
	resolveAnthropicReasoning,
	resolveMoonshotReasoning,
	resolveResponsesReasoning,
	resolveXaiReasoning,
	resolveZaiReasoning,
} from "./model-reasoning";

const OPENAI_OAUTH_ORIGINATOR = "codelia";
const OPENAI_OAUTH_USER_AGENT = "codelia-cli";

export type RuntimeModelFactoryInput = {
	provider: SupportedProvider;
	config: ResolvedModelConfig;
	auth: ProviderAuth;
	useMetadata: boolean;
	log: (message: string) => void;
	getOpenAiAccessToken?: () => Promise<{
		token: string;
		accountId?: string;
	}>;
};

export type RuntimeModelFactoryResult = {
	llm: BaseChatModel;
	resolvedModelName: string;
};

const requireApiKeyAuth = (provider: string, auth: ProviderAuth): string => {
	if (auth.method !== "api_key") {
		throw new Error(`${provider} requires an API key`);
	}
	return auth.api_key;
};

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const buildOpenAiClientOptions = (
	getOpenAiAccessToken: RuntimeModelFactoryInput["getOpenAiAccessToken"],
	auth: ProviderAuth,
	log: RuntimeModelFactoryInput["log"],
): Record<string, unknown> => {
	if (auth.method === "api_key") {
		return { apiKey: auth.api_key };
	}
	let accountId = auth.oauth.account_id;
	const enableDebugHttp = envTruthy(process.env.CODELIA_DEBUG);
	const apiKey = async () => {
		if (!getOpenAiAccessToken) {
			throw new Error("OpenAI OAuth token refresh is unavailable");
		}
		const result = await getOpenAiAccessToken();
		accountId = result.accountId ?? accountId;
		return result.token;
	};
	const fetchWithAccount = Object.assign(
		async (
			input: URL | RequestInfo,
			init?: RequestInit | BunFetchRequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers ?? {});
			if (!headers.has("originator")) {
				headers.set("originator", OPENAI_OAUTH_ORIGINATOR);
			}
			if (!headers.has("User-Agent")) {
				headers.set("User-Agent", OPENAI_OAUTH_USER_AGENT);
			}
			if (accountId) {
				headers.set("ChatGPT-Account-Id", accountId);
			}
			const nextInit = init ? { ...init, headers } : { headers };
			const response = await fetch(input, nextInit);
			if (enableDebugHttp && !response.ok) {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
				const requestId =
					response.headers.get("x-request-id") ??
					response.headers.get("cf-ray") ??
					"-";
				let body = "";
				try {
					body = await response.clone().text();
				} catch {
					body = "";
				}
				const snippet = body ? body.slice(0, 1000) : "(empty)";
				log(
					`openai http error status=${response.status} request_id=${requestId} url=${url} body=${snippet}`,
				);
			}
			return response;
		},
		{ preconnect: fetch.preconnect },
	) as typeof fetch;
	const defaultHeaders: Record<string, string> = {
		originator: OPENAI_OAUTH_ORIGINATOR,
		"User-Agent": OPENAI_OAUTH_USER_AGENT,
	};
	if (accountId) {
		defaultHeaders["ChatGPT-Account-ID"] = accountId;
	}
	return {
		apiKey,
		baseURL: OPENAI_OAUTH_BASE_URL,
		fetch: fetchWithAccount,
		...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
	};
};

const buildOpenRouterClientOptions = (
	auth: ProviderAuth,
): Record<string, unknown> => {
	const headers: Record<string, string> = {};
	const referer = readEnvValue("OPENROUTER_HTTP_REFERER");
	if (referer) {
		headers["HTTP-Referer"] = referer;
	}
	const title = readEnvValue("OPENROUTER_X_TITLE");
	if (title) {
		headers["X-Title"] = title;
	}
	return {
		apiKey: requireApiKeyAuth("OpenRouter", auth),
		...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
	};
};

const buildZaiClientOptions = (
	auth: ProviderAuth,
): { apiKey: string; baseURL?: string } => {
	const baseURL = readEnvValue("ZAI_BASE_URL");
	return {
		apiKey: requireApiKeyAuth("Z.ai", auth),
		...(baseURL ? { baseURL } : {}),
	};
};

const buildMoonshotClientOptions = (
	auth: ProviderAuth,
): { apiKey: string; baseURL?: string } => {
	const baseURL = readEnvValue("MOONSHOT_BASE_URL");
	return {
		apiKey: requireApiKeyAuth("Moonshot", auth),
		...(baseURL ? { baseURL } : {}),
	};
};

const buildXaiClientOptions = (
	auth: ProviderAuth,
): { apiKey: string; baseURL?: string } => {
	const baseURL = readEnvValue("XAI_BASE_URL");
	return {
		apiKey: requireApiKeyAuth("xAI", auth),
		...(baseURL ? { baseURL } : {}),
	};
};

const resolveModelMaxTokensFromEntry = (
	entry: ModelEntry | null,
): number | null => {
	const limits = entry?.limits;
	const candidates = [
		limits?.outputTokens,
		limits?.inputTokens,
		limits?.contextWindow,
	];
	for (const value of candidates) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			continue;
		}
		return Math.trunc(value);
	}
	return null;
};

const resolveAnthropicStaticModelMaxTokens = (model: string): number | null => {
	const spec = resolveModel(DEFAULT_MODEL_REGISTRY, model, "anthropic");
	const candidates = [
		spec?.maxOutputTokens,
		spec?.maxInputTokens,
		spec?.contextWindow,
	];
	for (const value of candidates) {
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
			continue;
		}
		return Math.trunc(value);
	}
	return null;
};

const resolveAnthropicModelMaxTokens = async (
	model: string,
	options: { useMetadata: boolean },
): Promise<number | null> => {
	if (!options.useMetadata) {
		return resolveAnthropicStaticModelMaxTokens(model);
	}
	const metadataService = new ModelMetadataServiceImpl({
		storagePathService: new StoragePathServiceImpl(),
	});
	const direct = await metadataService.getModelEntry("anthropic", model);
	const prefixed = model.startsWith("anthropic/")
		? null
		: await metadataService.getModelEntry("anthropic", `anthropic/${model}`);
	return (
		resolveModelMaxTokensFromEntry(direct) ??
		resolveModelMaxTokensFromEntry(prefixed) ??
		resolveAnthropicStaticModelMaxTokens(model)
	);
};

export const createRuntimeModel = async ({
	provider,
	config,
	auth,
	useMetadata,
	log,
	getOpenAiAccessToken,
}: RuntimeModelFactoryInput): Promise<RuntimeModelFactoryResult> => {
	const requestedReasoning =
		resolveReasoningEffort(config.reasoning) ?? "medium";
	const isFastRequested = config.fast === true;

	switch (provider) {
		case "openai": {
			const modelName = config.name ?? OPENAI_DEFAULT_MODEL;
			const providerModelName =
				resolveProviderModelId(DEFAULT_MODEL_REGISTRY, modelName, "openai") ??
				modelName;
			const reasoning = resolveResponsesReasoning({
				model: providerModelName,
				requested: requestedReasoning,
			});
			const textVerbosity = resolveTextVerbosity(config.verbosity);
			const websocketMode = config.experimental?.openai?.websocket_mode;
			const fastMode = resolveFastMode({
				provider: "openai",
				model: modelName,
				requested: isFastRequested,
			});
			return {
				llm: new ChatOpenAI({
					clientOptions: buildOpenAiClientOptions(
						getOpenAiAccessToken,
						auth,
						log,
					),
					model: modelName,
					providerModel: providerModelName,
					reasoningEffort: reasoning.effort,
					reasoningLevelRequested: reasoning.requested,
					reasoningLevelApplied: reasoning.applied,
					reasoningFallbackApplied: reasoning.fallbackApplied,
					...(textVerbosity ? { textVerbosity } : {}),
					...(fastMode.enabled && fastMode.provider === "openai"
						? { serviceTier: fastMode.serviceTier }
						: {}),
					...(websocketMode ? { websocketMode } : {}),
				}),
				resolvedModelName: modelName,
			};
		}
		case "openrouter": {
			const modelName = config.name ?? OPENAI_DEFAULT_MODEL;
			const reasoning = resolveResponsesReasoning({
				model: modelName,
				requested: requestedReasoning,
			});
			const textVerbosity = resolveTextVerbosity(config.verbosity);
			return {
				llm: new ChatOpenRouter({
					clientOptions: buildOpenRouterClientOptions(auth),
					model: modelName,
					reasoningEffort: reasoning.effort,
					reasoningLevelRequested: reasoning.requested,
					reasoningLevelApplied: reasoning.applied,
					reasoningFallbackApplied: reasoning.fallbackApplied,
					...(textVerbosity ? { textVerbosity } : {}),
				}),
				resolvedModelName: modelName,
			};
		}
		case "anthropic": {
			const modelName = config.name ?? ANTHROPIC_DEFAULT_MODEL;
			const reasoning = resolveAnthropicReasoning({
				model: modelName,
				requested: requestedReasoning,
				onMissingExplicitModel: (missingModel) => {
					log(
						`anthropic reasoning profile missing for model '${missingModel}', using conservative fallback`,
					);
				},
			});
			const modelMaxTokens = await resolveAnthropicModelMaxTokens(modelName, {
				useMetadata,
			});
			const maxTokens = resolveAnthropicMaxTokens({
				thinkingBudgetTokens:
					reasoning.thinking.type === "enabled"
						? reasoning.thinking.budget_tokens
						: 0,
				modelLimitMaxTokens: modelMaxTokens,
			});
			if (
				reasoning.thinking.type === "enabled" &&
				typeof modelMaxTokens === "number" &&
				modelMaxTokens <= reasoning.thinking.budget_tokens
			) {
				log(
					`anthropic model '${modelName}' max token limit (${modelMaxTokens}) is not above thinking budget (${reasoning.thinking.budget_tokens}); using max_tokens=${maxTokens} to satisfy API constraint`,
				);
			}
			const fastMode = resolveFastMode({
				provider: "anthropic",
				model: modelName,
				requested: isFastRequested,
			});
			return {
				llm: new ChatAnthropic({
					clientOptions: {
						apiKey: requireApiKeyAuth("Anthropic", auth),
					},
					model: modelName,
					maxTokens,
					invokeOptions: {
						thinking: reasoning.thinking,
						...(reasoning.outputConfig
							? { output_config: reasoning.outputConfig }
							: {}),
					},
					reasoningLevelRequested: reasoning.requested,
					reasoningLevelApplied: reasoning.applied,
					reasoningFallbackApplied: reasoning.fallbackApplied,
					reasoningBudgetPreset: reasoning.budgetPreset,
					...(fastMode.enabled && fastMode.provider === "anthropic"
						? { fastMode: true }
						: {}),
				}),
				resolvedModelName: modelName,
			};
		}
		case "zai": {
			const modelName = config.name ?? ZAI_DEFAULT_MODEL;
			const reasoning = resolveZaiReasoning({
				requested: requestedReasoning,
			});
			const providerModelName =
				resolveProviderModelId(DEFAULT_MODEL_REGISTRY, modelName, "zai") ??
				modelName;
			const supportsReasoningEffort =
				ZAI_REASONING_EFFORT_MODELS.has(providerModelName);
			return {
				llm: new ChatZai({
					...buildZaiClientOptions(auth),
					model: modelName,
					reasoningEffort: supportsReasoningEffort ? reasoning.effort : null,
					reasoningLevelRequested: reasoning.requested,
					reasoningLevelApplied: supportsReasoningEffort
						? reasoning.applied
						: undefined,
					reasoningFallbackApplied: supportsReasoningEffort
						? reasoning.fallbackApplied
						: undefined,
				}),
				resolvedModelName: modelName,
			};
		}
		case "moonshot": {
			const modelName = config.name ?? MOONSHOT_DEFAULT_MODEL;
			const reasoning = resolveMoonshotReasoning({
				requested: requestedReasoning,
			});
			return {
				llm: new ChatMoonshot({
					...buildMoonshotClientOptions(auth),
					model: modelName,
					reasoningLevelRequested: reasoning.requested,
				}),
				resolvedModelName: modelName,
			};
		}
		case "xai": {
			const modelName = config.name ?? XAI_DEFAULT_MODEL;
			const reasoning = resolveXaiReasoning({
				requested: requestedReasoning,
			});
			return {
				llm: new ChatXai({
					clientOptions: buildXaiClientOptions(auth),
					model: modelName,
					reasoningEffort: reasoning.effort,
					reasoningLevelRequested: reasoning.requested,
					reasoningLevelApplied: reasoning.applied,
					reasoningFallbackApplied: reasoning.fallbackApplied,
				}),
				resolvedModelName: modelName,
			};
		}
		default: {
			const unsupportedProvider: never = provider;
			throw new Error(`Unsupported model.provider: ${unsupportedProvider}`);
		}
	}
};
