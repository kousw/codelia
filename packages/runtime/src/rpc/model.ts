import { updateModelConfig } from "@codelia/config-loader";
import {
	DEFAULT_MODEL_REGISTRY,
	type ModelEntry,
	listModels,
	resolveModel,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import type {
	ModelListDetails,
	ModelListParams,
	ModelListResult,
	ModelSetParams,
	ModelSetResult,
} from "@codelia/protocol";
import { resolveConfigPath, resolveModelConfig } from "../config";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";

export type ModelHandlersDeps = {
	state: RuntimeState;
	log: (message: string) => void;
};

const isSupportedProvider = (
	provider: string,
): provider is "openai" | "anthropic" =>
	provider === "openai" || provider === "anthropic";

const resolveProviderModelEntry = (
	providerEntries: Record<string, ModelEntry> | null,
	provider: "openai" | "anthropic",
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
	provider: "openai" | "anthropic",
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
	provider: "openai" | "anthropic",
): Promise<Record<string, ModelEntry> | null> => {
	const metadataService = new ModelMetadataServiceImpl();
	const allEntries = await metadataService.getAllModelEntries();
	return allEntries[provider] ?? null;
};

export const buildProviderModelList = async ({
	provider,
	includeDetails,
	log,
}: {
	provider: "openai" | "anthropic";
	includeDetails: boolean;
	log: (message: string) => void;
}): Promise<Pick<ModelListResult, "models" | "details">> => {
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
				code: -32602,
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
			sendError(id, { code: -32000, message: String(error) });
			return;
		}
		const provider = requestedProvider ?? configuredProvider ?? "openai";
		if (!isSupportedProvider(provider)) {
			sendError(id, {
				code: -32602,
				message: `unsupported provider: ${provider}`,
			});
			return;
		}
		const { models, details } = await buildProviderModelList({
			provider,
			includeDetails,
			log,
		});
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
			sendError(id, { code: -32001, message: "runtime busy" });
			return;
		}
		const provider = params?.provider ?? "openai";
		const name = params?.name?.trim();
		if (!name) {
			sendError(id, { code: -32602, message: "model name is required" });
			return;
		}
		if (provider !== "openai" && provider !== "anthropic") {
			sendError(id, {
				code: -32602,
				message: `unsupported provider: ${provider}`,
			});
			return;
		}
		const spec = resolveModel(DEFAULT_MODEL_REGISTRY, name, provider);
		if (!spec) {
			sendError(id, { code: -32602, message: `unknown model: ${name}` });
			return;
		}
		try {
			const configPath = resolveConfigPath();
			await updateModelConfig(configPath, { provider, name });
			state.agent = null;
			const result: ModelSetResult = { provider, name };
			sendResult(id, result);
			log(`model.set ${provider}/${name}`);
		} catch (error) {
			sendError(id, { code: -32000, message: String(error) });
		}
	};

	return { handleModelList, handleModelSet };
};
