import type { ResponsesProviderConfig } from "@codelia/config";
import type { ModelReasoningLevel } from "@codelia/shared-types";
import {
	DEEPSEEK_DEFAULT_MODEL,
	DEEPSEEK_MODELS,
	resolveDeepSeekEffort,
} from "../../models/deepseek";
import { createModelRegistry, resolveModel } from "../../models/registry";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../base";
import { createProviderValidationError } from "../failures";
import { ChatResponses, type ResponsesInvokeOptions } from "../responses/chat";

const registry = createModelRegistry(DEEPSEEK_MODELS);
const endpoint: ResponsesProviderConfig = {
	type: "responses",
	base_url: "https://api.deepseek.com",
	timeout_ms: 20 * 60 * 1000,
	retry: "off",
	models: Object.fromEntries(
		DEEPSEEK_MODELS.map((spec) => [
			spec.id,
			{
				context_window: spec.contextWindow,
				max_input_tokens: spec.maxInputTokens,
				max_output_tokens: spec.maxOutputTokens,
				supports_tools: spec.supportsTools,
				supports_reasoning: spec.supportsReasoning,
				supports_json_schema: spec.supportsJsonSchema,
				supports_vision: spec.supportsVision,
				reasoning_levels: ["low", "high", "max"],
			},
		]),
	),
};

const modelId = (name: string): string => {
	const spec = resolveModel(registry, name, "deepseek");
	if (!spec)
		throw createProviderValidationError(
			"deepseek",
			`Unsupported DeepSeek model: ${name}`,
		);
	return spec.id;
};

/** Official stateless Responses endpoint with independent API-key authentication. */
export class ChatDeepSeek
	implements BaseChatModel<"deepseek", ResponsesInvokeOptions>
{
	readonly provider = "deepseek" as const;
	readonly model: string;
	readonly retryPolicy;
	private readonly transport: ChatResponses;
	private readonly requestedEffort: ModelReasoningLevel;

	constructor(options: {
		apiKey: string;
		model?: string;
		reasoningEffort?: ModelReasoningLevel;
		fetch?: typeof fetch;
	}) {
		if (!options.apiKey.trim())
			throw createProviderValidationError(
				"deepseek",
				"DeepSeek requires an API key",
			);
		this.model = modelId(options.model ?? DEEPSEEK_DEFAULT_MODEL);
		this.requestedEffort = options.reasoningEffort ?? "high";
		this.transport = new ChatResponses({
			provider: this.provider,
			model: this.model,
			apiKey: options.apiKey,
			endpoint,
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
		this.retryPolicy = this.transport.retryPolicy;
	}

	readonly classifyFailure = (error: unknown) =>
		this.transport.classifyFailure(error);

	async ainvoke(
		input: ChatInvokeInput & { options?: ResponsesInvokeOptions },
		context?: ChatInvokeContext,
	) {
		if (
			input.toolChoice &&
			!["auto", "none", "required"].includes(input.toolChoice)
		)
			throw createProviderValidationError(
				"deepseek",
				"DeepSeek thinking mode does not support forced named tool choice",
			);
		const requested = input.options?.reasoningEffort ?? this.requestedEffort;
		const effort = resolveDeepSeekEffort(requested);
		const completion = await this.transport.ainvoke(
			{
				...input,
				model: modelId(input.model ?? this.model),
				options: { ...input.options, reasoningEffort: effort },
			},
			context,
		);
		if (completion.stop_reason !== "completed")
			throw createProviderValidationError(
				"deepseek",
				"DeepSeek response did not complete; partial output was not accepted",
			);
		const meta =
			typeof completion.provider_meta === "object" &&
			completion.provider_meta !== null
				? completion.provider_meta
				: {};
		return {
			...completion,
			...(completion.usage
				? {
						usage: {
							...completion.usage,
							model: modelId(input.model ?? this.model),
						},
					}
				: {}),
			provider_meta: {
				...meta,
				reasoning_requested: requested,
				reasoning_applied: effort,
				reasoning_effort: effort,
				reasoning_fallback: requested !== effort,
			},
		};
	}
}
