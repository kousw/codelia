import { updateModelConfig } from "@codelia/config-loader";
import {
	DEFAULT_MODEL_REGISTRY,
	listModels,
	resolveModel,
} from "@codelia/core";
import { ModelMetadataServiceImpl } from "@codelia/model-metadata";
import type {
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
		if (
			requestedProvider &&
			requestedProvider !== "openai" &&
			requestedProvider !== "anthropic"
		) {
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
		if (provider !== "openai" && provider !== "anthropic") {
			sendError(id, {
				code: -32602,
				message: `unsupported provider: ${provider}`,
			});
			return;
		}
		const models = listModels(DEFAULT_MODEL_REGISTRY, provider)
			.map((model) => model.id)
			.sort();
		if (current && !models.includes(current)) {
			current = undefined;
		}
		let details: ModelListResult["details"];
		if (includeDetails) {
			try {
				const metadataService = new ModelMetadataServiceImpl();
				const entries = await metadataService.getAllModelEntries();
				const providerEntries = entries[provider];
				if (providerEntries) {
					const nextDetails: NonNullable<ModelListResult["details"]> = {};
					for (const model of models) {
						const limits = providerEntries[model]?.limits;
						if (!limits) continue;
						const detail: {
							context_window?: number;
							max_input_tokens?: number;
							max_output_tokens?: number;
						} = {};
						if (
							typeof limits.contextWindow === "number" &&
							limits.contextWindow > 0
						) {
							detail.context_window = limits.contextWindow;
						}
						if (
							typeof limits.inputTokens === "number" &&
							limits.inputTokens > 0
						) {
							detail.max_input_tokens = limits.inputTokens;
						}
						if (
							typeof limits.outputTokens === "number" &&
							limits.outputTokens > 0
						) {
							detail.max_output_tokens = limits.outputTokens;
						}
						if (Object.keys(detail).length > 0) {
							nextDetails[model] = detail;
						}
					}
					if (Object.keys(nextDetails).length > 0) {
						details = nextDetails;
					}
				}
			} catch (error) {
				log(`model.list details error: ${error}`);
			}
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
