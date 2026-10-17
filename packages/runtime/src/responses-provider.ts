import type { ResponsesProviderConfig } from "@codelia/config";
import {
	createModelRegistry,
	DEFAULT_MODEL_REGISTRY,
	type ModelSpec,
} from "@codelia/core";
import type { ResolvedModelConfig } from "./config";

export const getResponsesProvider = (
	config: ResolvedModelConfig,
	provider: string,
): ResponsesProviderConfig | undefined =>
	config.providers && Object.hasOwn(config.providers, provider)
		? config.providers[provider]
		: undefined;

export const configuredModelSpecs = (
	providers: ResolvedModelConfig["providers"],
): ModelSpec[] =>
	Object.entries(providers ?? {}).flatMap(([provider, endpoint]) =>
		Object.entries(endpoint.models).map(([model, spec]) => ({
			id: `${provider}/${model}`,
			provider,
			providerModelId: model,
			aliases: [model],
			contextWindow: spec.context_window,
			maxInputTokens: spec.max_input_tokens,
			maxOutputTokens: spec.max_output_tokens,
			supportsTools: spec.supports_tools === true,
			supportsVision: spec.supports_vision === true,
			supportsReasoning: spec.supports_reasoning === true,
			supportsJsonSchema: spec.supports_json_schema === true,
			supportsFast: false,
		})),
	);

export const buildConfiguredModelRegistry = (
	providers: ResolvedModelConfig["providers"],
) =>
	createModelRegistry([
		...Object.values(DEFAULT_MODEL_REGISTRY.modelsById),
		...configuredModelSpecs(providers),
	]);

export const resolveConfiguredReasoning = (
	config: ResolvedModelConfig,
	provider: string,
	model: string,
) => {
	const endpoint = getResponsesProvider(config, provider);
	const spec =
		endpoint && Object.hasOwn(endpoint.models, model)
			? endpoint.models[model]
			: undefined;
	if (!spec) throw new Error(`Unknown model for ${provider}: ${model}`);
	if (!spec.supports_reasoning) {
		return undefined;
	}
	const levels = spec.reasoning_levels ?? ["low", "medium", "high"];
	const effort =
		config.reasoning ?? (levels.includes("medium") ? "medium" : levels[0]);
	if (!levels.some((level) => level === effort))
		throw new Error(
			`Unsupported reasoning effort for ${provider}/${model}: ${effort}`,
		);
	return effort as (typeof levels)[number];
};
