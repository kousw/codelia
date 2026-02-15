import { updateModelConfig } from "@codelia/config-loader";
import {
	DEFAULT_MODEL_REGISTRY,
	listModels,
	type ModelEntry,
	resolveModel,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import {
	RPC_ERROR_CODE,
	type ModelListDetails,
	type ModelListParams,
	type ModelListResult,
	type ModelSetParams,
	type ModelSetResult,
} from "@codelia/protocol";
import { AuthResolver } from "../auth/resolver";
import { AuthStore } from "../auth/store";
import {
	readEnvValue,
	resolveConfigPath,
	resolveModelConfig,
} from "../config";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

export type ModelHandlersDeps = {
	state: RuntimeState;
	log: (message: string) => void;
};

type SupportedModelProvider = "openai" | "anthropic" | "openrouter";
type StaticModelProvider = Exclude<SupportedModelProvider, "openrouter">;

const isSupportedProvider = (
	provider: string,
): provider is SupportedModelProvider =>
	provider === "openai" ||
	provider === "anthropic" ||
	provider === "openrouter";

const resolveProviderModelEntry = (
	providerEntries: Record<string, ModelEntry> | null,
	provider: StaticModelProvider,
	model: string,
): ModelEntry | null => {
	if (!providerEntries) return null;
	return (
		providerEntries[model] ?? providerEntries[`${provider}/${model}`] ?? null
	);
};

const parseReleaseTimestamp = (entry: ModelEntry | null): number | null => {
	const releaseDate = entry?.releaseDate?.trim();
	if (!releaseDate) return null;
	const timestamp = Date.parse(releaseDate);
	if (Number.isNaN(timestamp)) return null;
	return timestamp;
};

const normalizeUsdPer1M = (value: number | undefined): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return value;
};

const buildModelListDetail = (
	entry: ModelEntry | null,
): ModelListDetails | null => {
	if (!entry) return null;
	const detail: ModelListDetails = {};
	if (entry.releaseDate?.trim()) {
		detail.release_date = entry.releaseDate.trim();
	}
	const limits = entry.limits;
	if (
		typeof limits?.contextWindow === "number" &&
		Number.isFinite(limits.contextWindow) &&
		limits.contextWindow > 0
	) {
		detail.context_window = limits.contextWindow;
	}
	if (
		typeof limits?.inputTokens === "number" &&
		Number.isFinite(limits.inputTokens) &&
		limits.inputTokens > 0
	) {
		detail.max_input_tokens = limits.inputTokens;
	}
	if (
		typeof limits?.outputTokens === "number" &&
		Number.isFinite(limits.outputTokens) &&
		limits.outputTokens > 0
	) {
		detail.max_output_tokens = limits.outputTokens;
	}
	const inputCost = normalizeUsdPer1M(entry.cost?.input);
	if (inputCost !== undefined) {
		detail.cost_per_1m_input_tokens_usd = inputCost;
	}
	const outputCost = normalizeUsdPer1M(entry.cost?.output);
	if (outputCost !== undefined) {
		detail.cost_per_1m_output_tokens_usd = outputCost;
	}
	return Object.keys(detail).length ? detail : null;
};

const sortModelsByReleaseDate = (
	models: string[],
	provider: StaticModelProvider,
	providerEntries: Record<string, ModelEntry> | null,
): string[] => {
	const sortable = models.map((model, index) => ({
		model,
		index,
		releaseTimestamp: parseReleaseTimestamp(
			resolveProviderModelEntry(providerEntries, provider, model),
		),
	}));
	sortable.sort((left, right) => {
		if (
			left.releaseTimestamp !== null &&
			right.releaseTimestamp !== null &&
			left.releaseTimestamp !== right.releaseTimestamp
		) {
			return right.releaseTimestamp - left.releaseTimestamp;
		}
		if (left.releaseTimestamp !== null && right.releaseTimestamp === null) {
			return -1;
		}
		if (left.releaseTimestamp === null && right.releaseTimestamp !== null) {
			return 1;
		}
		return left.index - right.index;
	});
	return sortable.map((item) => item.model);
};

const loadProviderModelEntries = async (
	provider: StaticModelProvider,
): Promise<Record<string, ModelEntry> | null> => {
	const metadataService = new ModelMetadataServiceImpl();
	const allEntries = await metadataService.getAllModelEntries();
	return allEntries[provider] ?? null;
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const parseUnixSecondsToDate = (value: unknown): string | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	const date = new Date(Math.floor(value) * 1000);
	const timestamp = date.getTime();
	if (!Number.isFinite(timestamp)) {
		return undefined;
	}
	return date.toISOString().slice(0, 10);
};

const parsePositiveNumber = (value: unknown): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value;
};

const buildOpenRouterHeaders = (apiKey: string): Headers => {
	const headers = new Headers();
	headers.set("Authorization", `Bearer ${apiKey}`);
	const referer = readEnvValue("OPENROUTER_HTTP_REFERER");
	if (referer) {
		headers.set("HTTP-Referer", referer);
	}
	const title = readEnvValue("OPENROUTER_X_TITLE");
	if (title) {
		headers.set("X-Title", title);
	}
	return headers;
};

const resolveOpenRouterApiKey = async (): Promise<string | null> => {
	const envKey = readEnvValue("OPENROUTER_API_KEY");
	if (envKey) {
		return envKey;
	}
	const store = new AuthStore();
	const auth = await store.load();
	const providerAuth = auth.providers.openrouter;
	if (providerAuth?.method !== "api_key") {
		return null;
	}
	const value = providerAuth.api_key.trim();
	return value ? value : null;
};

const resolveOpenRouterApiKeyWithPrompt = async ({
	state,
	log,
}: {
	state?: RuntimeState;
	log: (message: string) => void;
}): Promise<string> => {
	const existing = await resolveOpenRouterApiKey();
	if (existing) {
		return existing;
	}
	if (!state) {
		throw new Error("OpenRouter API key is required");
	}
	const authResolver = await AuthResolver.create(state, log);
	const auth = await authResolver.resolveProviderAuth("openrouter");
	if (auth.method !== "api_key") {
		throw new Error("OpenRouter API key is required");
	}
	const value = auth.api_key.trim();
	if (!value) {
		throw new Error("OpenRouter API key is required");
	}
	return value;
};

type OpenRouterModel = {
	id: string;
	created?: number;
	context_length?: number;
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
};

const parseOpenRouterModel = (value: unknown): OpenRouterModel | null => {
	if (!value || typeof value !== "object") {
		return null;
	}
	const entry = value as Record<string, unknown>;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!id) {
		return null;
	}
	const topProvider =
		entry.top_provider && typeof entry.top_provider === "object"
			? (entry.top_provider as Record<string, unknown>)
			: null;
	return {
		id,
		created:
			typeof entry.created === "number" && Number.isFinite(entry.created)
				? entry.created
				: undefined,
		context_length: parsePositiveNumber(entry.context_length),
		top_provider: topProvider
			? {
					context_length: parsePositiveNumber(topProvider.context_length),
					max_completion_tokens: parsePositiveNumber(
						topProvider.max_completion_tokens,
					),
				}
			: undefined,
	};
};

const fetchOpenRouterModels = async (
	apiKey: string,
): Promise<OpenRouterModel[]> => {
	const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
		headers: buildOpenRouterHeaders(apiKey),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const snippet = body ? body.slice(0, 300) : "(empty)";
		throw new Error(
			`OpenRouter models request failed (${response.status}): ${snippet}`,
		);
	}
	const payload = (await response.json()) as unknown;
	if (!payload || typeof payload !== "object") {
		throw new Error("OpenRouter models response is not an object");
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error("OpenRouter models response has no data array");
	}
	const models = data
		.map((entry) => parseOpenRouterModel(entry))
		.filter((entry): entry is OpenRouterModel => !!entry);
	models.sort((left, right) => {
		const leftCreated = left.created ?? 0;
		const rightCreated = right.created ?? 0;
		if (leftCreated !== rightCreated) {
			return rightCreated - leftCreated;
		}
		return left.id.localeCompare(right.id);
	});
	return models;
};

const buildOpenRouterModelList = async ({
	includeDetails,
	state,
	log,
}: {
	includeDetails: boolean;
	state?: RuntimeState;
	log: (message: string) => void;
}): Promise<Pick<ModelListResult, "models" | "details">> => {
	const apiKey = await resolveOpenRouterApiKeyWithPrompt({ state, log });
	const models = await fetchOpenRouterModels(apiKey);
	const ids = models.map((model) => model.id);
	if (!includeDetails) {
		return { models: ids };
	}
	const details: NonNullable<ModelListResult["details"]> = {};
	for (const model of models) {
		const detail: ModelListDetails = {};
		const releaseDate = parseUnixSecondsToDate(model.created);
		if (releaseDate) {
			detail.release_date = releaseDate;
		}
		const contextWindow =
			model.context_length ?? model.top_provider?.context_length;
		if (contextWindow && contextWindow > 0) {
			detail.context_window = contextWindow;
			detail.max_input_tokens = contextWindow;
		}
		const maxOutputTokens = model.top_provider?.max_completion_tokens;
		if (maxOutputTokens && maxOutputTokens > 0) {
			detail.max_output_tokens = maxOutputTokens;
		}
		if (Object.keys(detail).length) {
			details[model.id] = detail;
		}
	}
	return Object.keys(details).length ? { models: ids, details } : { models: ids };
};

export const buildProviderModelList = async ({
	provider,
	includeDetails,
	state,
	log,
}: {
	provider: SupportedModelProvider;
	includeDetails: boolean;
	state?: RuntimeState;
	log: (message: string) => void;
}): Promise<Pick<ModelListResult, "models" | "details">> => {
	if (provider === "openrouter") {
		return buildOpenRouterModelList({ includeDetails, state, log });
	}

	let providerEntries: Record<string, ModelEntry> | null = null;
	try {
		providerEntries = await loadProviderModelEntries(provider);
	} catch (error) {
		if (includeDetails) {
			log(`model.list details error: ${error}`);
		}
	}

	const models = sortModelsByReleaseDate(
		listModels(DEFAULT_MODEL_REGISTRY, provider).map((model) => model.id),
		provider,
		providerEntries,
	);
	if (!includeDetails || !providerEntries) {
		return { models };
	}

	const details: NonNullable<ModelListResult["details"]> = {};
	for (const model of models) {
		const detail = buildModelListDetail(
			resolveProviderModelEntry(providerEntries, provider, model),
		);
		if (detail) {
			details[model] = detail;
		}
	}
	return Object.keys(details).length ? { models, details } : { models };
};

export const createModelHandlers = ({
	state,
	log,
}: ModelHandlersDeps): {
	handleModelList: (id: string, params: ModelListParams) => Promise<void>;
	handleModelSet: (id: string, params: ModelSetParams) => Promise<void>;
} => {
	const handleModelList = async (
		id: string,
		params: ModelListParams,
	): Promise<void> => {
		const requestedProvider = params?.provider;
		const includeDetails = params?.include_details ?? false;
		if (requestedProvider && !isSupportedProvider(requestedProvider)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported provider: ${requestedProvider}`,
			});
			return;
		}
		let current: string | undefined;
		let configuredProvider: string | undefined;
		try {
			const config = await resolveModelConfig();
			configuredProvider = config.provider ?? "openai";
			if (!requestedProvider || requestedProvider === configuredProvider) {
				current = config.name;
			}
		} catch (error) {
			sendError(id, { code: RPC_ERROR_CODE.RUNTIME_INTERNAL, message: String(error) });
			return;
		}
		const provider = requestedProvider ?? configuredProvider ?? "openai";
		if (!isSupportedProvider(provider)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported provider: ${provider}`,
			});
			return;
		}
		let models: string[];
		let details: Record<string, ModelListDetails> | undefined;
		try {
			const result = await buildProviderModelList({
				provider,
				includeDetails,
				state,
				log,
			});
			models = result.models;
			details = result.details;
		} catch (error) {
			sendError(id, { code: RPC_ERROR_CODE.RUNTIME_INTERNAL, message: String(error) });
			return;
		}
		if (current && !models.includes(current)) {
			current = undefined;
		}
		const result: ModelListResult = {
			provider,
			models,
			current,
			...(details ? { details } : {}),
		};
		sendResult(id, result);
	};

	const handleModelSet = async (
		id: string,
		params: ModelSetParams,
	): Promise<void> => {
		if (state.activeRunId) {
			sendError(id, { code: RPC_ERROR_CODE.RUNTIME_BUSY, message: "runtime busy" });
			return;
		}
		const provider = params?.provider ?? "openai";
		const name = params?.name?.trim();
		if (!name) {
			sendError(id, { code: RPC_ERROR_CODE.INVALID_PARAMS, message: "model name is required" });
			return;
		}
		if (
			provider !== "openai" &&
			provider !== "anthropic" &&
			provider !== "openrouter"
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported provider: ${provider}`,
			});
			return;
		}
		if (provider !== "openrouter") {
			const spec = resolveModel(DEFAULT_MODEL_REGISTRY, name, provider);
			if (!spec) {
				sendError(id, { code: RPC_ERROR_CODE.INVALID_PARAMS, message: `unknown model: ${name}` });
				return;
			}
		}
		try {
			const configPath = resolveConfigPath();
			await updateModelConfig(configPath, { provider, name });
			state.agent = null;
			const result: ModelSetResult = { provider, name };
			sendResult(id, result);
			log(`model.set ${provider}/${name}`);
		} catch (error) {
			sendError(id, { code: RPC_ERROR_CODE.RUNTIME_INTERNAL, message: String(error) });
		}
	};

	return { handleModelList, handleModelSet };
};
