import {
	applyModelMetadata,
	DEFAULT_MODEL_REGISTRY,
	isUsableModelSpec,
	listModels,
	type ModelEntry,
	type ModelRegistry,
	resolveModel,
	resolveProviderModelId,
	type SessionStateStore,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import {
	type ModelListDetails,
	type ModelListParams,
	type ModelListResult,
	type ModelSetParams,
	type ModelSetResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { AuthResolver } from "../auth/resolver";
import { AuthStore } from "../auth/store";
import {
	readEnvValue,
	resolveModelConfig,
	resolveReasoningEffort,
	updateModel,
} from "../config";
import {
	clearSessionModelOverride,
	mergeSessionModelOverrideIntoMeta,
	resolveEffectiveModelConfig,
	setSessionModelOverride,
} from "../effective-model";
import { resolveFastMode } from "../model-fast";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

export type ModelHandlersDeps = {
	state: RuntimeState;
	log: (message: string) => void;
	sessionStateStore?: SessionStateStore;
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
	if (!providerEntries) {
		return null;
	}
	const providerModelId =
		resolveProviderModelId(DEFAULT_MODEL_REGISTRY, model, provider) ?? model;
	const candidates = [
		model,
		`${provider}/${model}`,
		providerModelId,
		`${provider}/${providerModelId}`,
	].filter((value, index, array) => array.indexOf(value) === index);
	for (const candidate of candidates) {
		const entry = providerEntries[candidate];
		if (entry) {
			return entry;
		}
	}
	return null;
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
	registry: ModelRegistry,
	provider: StaticModelProvider,
	model: string,
): ModelListDetails | null => {
	const spec = resolveModel(registry, model, provider);
	if (!entry && !spec) return null;
	const detail: ModelListDetails = {};
	if (entry?.releaseDate?.trim()) {
		detail.release_date = entry.releaseDate.trim();
	}
	if (
		typeof spec?.contextWindow === "number" &&
		Number.isFinite(spec.contextWindow) &&
		spec.contextWindow > 0
	) {
		detail.context_window = spec.contextWindow;
	}
	if (
		typeof spec?.maxInputTokens === "number" &&
		Number.isFinite(spec.maxInputTokens) &&
		spec.maxInputTokens > 0
	) {
		detail.max_input_tokens = spec.maxInputTokens;
	}
	if (
		typeof spec?.maxOutputTokens === "number" &&
		Number.isFinite(spec.maxOutputTokens) &&
		spec.maxOutputTokens > 0
	) {
		detail.max_output_tokens = spec.maxOutputTokens;
	}
	const inputCost = normalizeUsdPer1M(entry?.cost?.input);
	if (inputCost !== undefined) {
		detail.cost_per_1m_input_tokens_usd = inputCost;
	}
	const outputCost = normalizeUsdPer1M(entry?.cost?.output);
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
	return Object.keys(details).length
		? { models: ids, details }
		: { models: ids };
};

export const buildProviderModelList = async ({
	provider,
	includeDetails,
	state,
	log,
	providerEntriesOverride,
}: {
	provider: SupportedModelProvider;
	includeDetails: boolean;
	state?: RuntimeState;
	log: (message: string) => void;
	providerEntriesOverride?: Record<string, ModelEntry> | null;
}): Promise<Pick<ModelListResult, "models" | "details">> => {
	if (provider === "openrouter") {
		return buildOpenRouterModelList({ includeDetails, state, log });
	}

	let providerEntries: Record<string, ModelEntry> | null = null;
	if (providerEntriesOverride !== undefined) {
		providerEntries = providerEntriesOverride;
	} else {
		try {
			providerEntries = await loadProviderModelEntries(provider);
		} catch (error) {
			if (includeDetails) {
				log(`model.list details error: ${error}`);
			}
		}
	}

	const mergedRegistry = applyModelMetadata(DEFAULT_MODEL_REGISTRY, {
		models: {
			openai: provider === "openai" ? (providerEntries ?? {}) : {},
			anthropic: provider === "anthropic" ? (providerEntries ?? {}) : {},
			openrouter: {},
			google: {},
		},
	});
	const models = sortModelsByReleaseDate(
		listModels(DEFAULT_MODEL_REGISTRY, provider)
			.filter((model) =>
				isUsableModelSpec(resolveModel(mergedRegistry, model.id, provider)),
			)
			.map((model) => model.id),
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
			mergedRegistry,
			provider,
			model,
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
	sessionStateStore,
}: ModelHandlersDeps): {
	handleModelList: (id: string, params: ModelListParams) => Promise<void>;
	handleModelSet: (id: string, params: ModelSetParams) => Promise<void>;
} => {
	const persistSessionModelOverride = async (): Promise<void> => {
		const sessionId = state.sessionId;
		const snapshot =
			sessionId && sessionStateStore
				? await sessionStateStore.load(sessionId)
				: null;
		const nextMeta = mergeSessionModelOverrideIntoMeta(
			snapshot?.meta ?? state.sessionMeta ?? undefined,
			state.sessionModelOverride,
		);
		state.sessionMeta = nextMeta ?? null;
		if (!snapshot || !sessionStateStore) return;
		await sessionStateStore.save({
			...snapshot,
			updated_at: new Date().toISOString(),
			meta: nextMeta,
		});
	};

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
		let source: "config" | "session" = "config";
		let configuredProvider: string | undefined;
		let configuredReasoning: "low" | "medium" | "high" | "xhigh" | undefined;
		let configuredFast: boolean | undefined;
		try {
			const workingDir =
				state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined;
			const config = await resolveEffectiveModelConfig(state, workingDir);
			source = config.source;
			configuredProvider = config.provider ?? "openai";
			configuredReasoning = resolveReasoningEffort(config.reasoning);
			if (!requestedProvider || requestedProvider === configuredProvider) {
				current = config.name;
			}
			if (
				config.fast !== undefined &&
				config.name &&
				isSupportedProvider(configuredProvider)
			) {
				configuredFast = resolveFastMode({
					provider: configuredProvider,
					model: config.name,
					requested: config.fast,
				}).enabled;
			}
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: String(error),
			});
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
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: String(error),
			});
			return;
		}
		if (current && !models.includes(current)) {
			current = undefined;
		}
		const result: ModelListResult = {
			provider,
			models,
			current,
			source,
			...(configuredReasoning ? { reasoning: configuredReasoning } : {}),
			...(configuredFast !== undefined ? { fast: configuredFast } : {}),
			...(details ? { details } : {}),
		};
		sendResult(id, result);
	};

	const handleModelSet = async (
		id: string,
		params: ModelSetParams,
	): Promise<void> => {
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const scope = params?.scope ?? "config";
		if (scope !== "config" && scope !== "session") {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported model scope: ${scope}`,
			});
			return;
		}
		const workingDir =
			state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? process.cwd();
		if (params?.reset) {
			if (scope !== "session") {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "model reset is only supported for session scope",
				});
				return;
			}
			try {
				clearSessionModelOverride(state);
				await persistSessionModelOverride();
				const config = await resolveModelConfig(workingDir);
				const provider = config.provider ?? "openai";
				const name = config.name;
				if (!name) {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
						message: "configured model name is missing",
					});
					return;
				}
				state.currentModelProvider = provider;
				state.currentModelName = name;
				state.currentModelSource = "config";
				state.agent = null;
				const effectiveReasoning = resolveReasoningEffort(config.reasoning);
				const effectiveFast = isSupportedProvider(provider)
					? resolveFastMode({
							provider,
							model: name,
							requested: config.fast,
						}).enabled
					: false;
				const result: ModelSetResult = {
					provider,
					name,
					source: "config",
					...(effectiveReasoning ? { reasoning: effectiveReasoning } : {}),
					...(config.fast !== undefined ? { fast: effectiveFast } : {}),
				};
				sendResult(id, result);
				log(`model.set reset session override -> ${provider}/${name}`);
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: String(error),
				});
			}
			return;
		}
		const provider = params?.provider ?? "openai";
		const name = params?.name?.trim();
		if (!name) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "model name is required",
			});
			return;
		}
		let reasoning: "low" | "medium" | "high" | "xhigh" | undefined;
		if (params?.reasoning !== undefined) {
			try {
				reasoning = resolveReasoningEffort(params.reasoning);
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: String(error),
				});
				return;
			}
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
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `unknown model: ${name}`,
				});
				return;
			}
		}
		try {
			let target: Awaited<ReturnType<typeof updateModel>> | null = null;
			if (scope === "config") {
				target = await updateModel(workingDir, {
					provider,
					name,
					...(reasoning ? { reasoning } : {}),
					...(params.fast !== undefined ? { fast: params.fast } : {}),
				});
				clearSessionModelOverride(state);
				await persistSessionModelOverride();
			} else {
				const baseConfig = await resolveModelConfig(workingDir);
				setSessionModelOverride(state, baseConfig, {
					provider,
					name,
					...(reasoning ? { reasoning } : {}),
					...(params.fast !== undefined ? { fast: params.fast } : {}),
				});
				await persistSessionModelOverride();
			}
			state.currentModelProvider = provider;
			state.currentModelName = name;
			state.currentModelSource = scope;
			state.agent = null;
			const updatedConfig = await resolveEffectiveModelConfig(
				state,
				workingDir,
			);
			const effectiveReasoning = resolveReasoningEffort(
				updatedConfig.reasoning,
			);
			const effectiveFast = resolveFastMode({
				provider,
				model: name,
				requested: updatedConfig.fast,
			}).enabled;
			const result: ModelSetResult = {
				provider,
				name,
				source: scope,
				...(effectiveReasoning ? { reasoning: effectiveReasoning } : {}),
				...(updatedConfig.fast !== undefined ? { fast: effectiveFast } : {}),
			};
			sendResult(id, result);
			const persistence =
				scope === "config" && target
					? ` scope=${target.scope} path=${target.path}`
					: " scope=session";
			log(
				`model.set ${provider}/${name}${effectiveReasoning ? ` reasoning=${effectiveReasoning}` : ""}${persistence}`,
			);
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: String(error),
			});
		}
	};

	return { handleModelList, handleModelSet };
};
