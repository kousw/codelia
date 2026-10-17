import { LlmStreamTiming } from "../stream-timing";
import type { ResponsesProviderConfig } from "@codelia/config";
import type { ModelReasoningLevel } from "@codelia/shared-types";
import OpenAI from "openai";
import type {
	Response as ApiResponse,
	ResponseCreateParamsBase,
} from "openai/resources/responses/responses";
import type { ChatInvokeCompletion } from "../../types/llm";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../base";
import {
	buildProviderFailure,
	classifyOpenAiCompatibleFailure,
	createProviderValidationError,
	extractProviderError,
	isProviderFailureError,
	ProviderFailureError,
} from "../failures";
import { OpenAiResponseAccumulator } from "../openai/response-accumulator";
import { toSdkReasoningEffort } from "../openai/responses-reasoning";
import {
	extractInstructions,
	toChatInvokeCompletion,
	toResponsesInput,
	toResponsesToolChoice,
	toResponsesTools,
} from "../openai/serializer";

export type ResponsesInvokeOptions = {
	reasoningEffort?: ModelReasoningLevel;
	maxOutputTokens?: number;
	text?: ResponseCreateParamsBase["text"];
};

/** Stateless HTTP Responses transport, independently named and authenticated. */
export class ChatResponses
	implements BaseChatModel<string, ResponsesInvokeOptions>
{
	readonly provider: string;
	readonly model: string;
	readonly retryPolicy;
	private readonly client: OpenAI;
	private readonly endpoint: ResponsesProviderConfig;
	private readonly reasoningEffort?: ModelReasoningLevel;
	private readonly textVerbosity?: "low" | "medium" | "high";

	constructor(options: {
		provider: string;
		model: string;
		endpoint: ResponsesProviderConfig;
		apiKey: string;
		reasoningEffort?: ModelReasoningLevel;
		textVerbosity?: "low" | "medium" | "high";
		fetch?: typeof fetch;
	}) {
		this.provider = options.provider;
		this.model = options.model;
		this.endpoint = options.endpoint;
		this.reasoningEffort = options.reasoningEffort;
		this.textVerbosity = options.textVerbosity;
		const retry = options.endpoint.retry;
		this.retryPolicy = {
			maxRetries: typeof retry === "object" ? retry.max_retries : 0,
			...(typeof retry === "object" && retry.base_delay_ms !== undefined
				? { baseDelayMs: retry.base_delay_ms }
				: {}),
		};
		this.client = new OpenAI({
			apiKey: options.apiKey,
			baseURL: options.endpoint.base_url,
			organization: null,
			project: null,
			maxRetries: 0,
			timeout: options.endpoint.timeout_ms ?? 60 * 60 * 1000,
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	}

	readonly classifyFailure = (error: unknown) => {
		if (isProviderFailureError(error)) return error.failure;
		const failure =
			error instanceof OpenAI.APIUserAbortError
				? buildProviderFailure(this.provider, "cancelled")
				: error instanceof OpenAI.APIConnectionTimeoutError
					? buildProviderFailure(this.provider, "timeout", { retryable: true })
					: error instanceof OpenAI.APIConnectionError
						? buildProviderFailure(this.provider, "network", {
								retryable: true,
							})
						: classifyOpenAiCompatibleFailure(this.provider, error);
		const extracted = extractProviderError(error);
		const code =
			typeof extracted.code === "string" &&
			/^[a-zA-Z0-9_.-]{1,80}$/.test(extracted.code)
				? extracted.code
				: undefined;
		return {
			...failure,
			...(extracted.status !== undefined ? { status: extracted.status } : {}),
			...(extracted.status === 413 ? { kind: "validation" as const } : {}),
			retryable: this.retryPolicy.maxRetries > 0 && failure.retryable,
			...(code ? { code } : {}),
			safeMessage: `${failure.safeMessage}${extracted.status !== undefined ? ` HTTP ${extracted.status}.` : ""}${code ? ` code=${code}.` : ""}`,
		};
	};

	async ainvoke(
		input: ChatInvokeInput & { options?: ResponsesInvokeOptions },
		context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion> {
		const model = input.model ?? this.model;
		const spec = Object.hasOwn(this.endpoint.models, model)
			? this.endpoint.models[model]
			: undefined;
		const invalid = (message: string): never => {
			throw createProviderValidationError(this.provider, message);
		};
		if (!spec) return invalid(`Unknown model for ${this.provider}: ${model}`);
		if (input.tools?.some((tool) => tool.type === "hosted_search"))
			invalid(
				`${this.provider} supports function tools only; hosted tools are unavailable`,
			);
		if (input.tools?.length && !spec.supports_tools)
			invalid(`${this.provider}/${model} does not support tools`);
		const items = toResponsesInput(input.messages);
		if (
			!spec.supports_vision &&
			Array.isArray(items) &&
			items.some(
				(item) =>
					"content" in item &&
					Array.isArray(item.content) &&
					item.content.some((part) => part.type === "input_image"),
			)
		)
			invalid(`${this.provider}/${model} vision is disabled`);
		const text = input.options?.text;
		if (
			text?.format &&
			text.format.type !== "text" &&
			!spec.supports_json_schema
		)
			invalid(`${this.provider}/${model} does not support structured output`);
		const features = this.endpoint.features;
		const effort = input.options?.reasoningEffort ?? this.reasoningEffort;
		if (effort && !spec.supports_reasoning)
			invalid(`${this.provider}/${model} reasoning is disabled`);
		const levels = spec.reasoning_levels ?? ["low", "medium", "high"];
		if (effort && !levels.includes(effort))
			invalid(
				`Unsupported reasoning effort for ${this.provider}/${model}: ${effort}`,
			);
		const output = input.options?.maxOutputTokens ?? spec.max_output_tokens;
		if (
			output !== undefined &&
			(!Number.isSafeInteger(output) ||
				output < 1 ||
				output > (spec.max_output_tokens ?? spec.context_window))
		)
			invalid(`Invalid max output tokens for ${this.provider}/${model}`);
		const tools = toResponsesTools(input.tools);
		const choice = toResponsesToolChoice(input.toolChoice);
		const instructions = extractInstructions(input.messages);
		const request: ResponseCreateParamsBase = {
			model,
			input: items,
			store: false,
			...(instructions ? { instructions } : {}),
			...(tools ? { tools } : {}),
			...(choice ? { tool_choice: choice } : {}),
			...(output !== undefined ? { max_output_tokens: output } : {}),
		};
		if (spec.supports_reasoning && (effort || features?.reasoning_summary))
			request.reasoning = {
				...(effort ? { effort: toSdkReasoningEffort(effort) } : {}),
				...(features?.reasoning_summary
					? { summary: features.reasoning_summary }
					: {}),
			};
		if (spec.supports_reasoning && features?.encrypted_reasoning)
			request.include = ["reasoning.encrypted_content"];
		if (
			text?.format ||
			(features?.text_verbosity && (text?.verbosity || this.textVerbosity))
		)
			request.text = {
				...(text?.format ? { format: text.format } : {}),
				...(features?.text_verbosity && (text?.verbosity || this.textVerbosity)
					? { verbosity: text?.verbosity ?? this.textVerbosity }
					: {}),
			};
		if (features?.prompt_cache_key && context?.sessionKey)
			request.prompt_cache_key = context.sessionKey;
		const timing = new LlmStreamTiming();
		let streamStarted = false;
		try {
			const stream = await this.client.responses.create(
				{ ...request, stream: true },
				{
					...(input.signal ? { signal: input.signal } : {}),
					...(features?.session_id_header && context?.sessionKey
						? { headers: { session_id: context.sessionKey } }
						: {}),
				},
			);
			streamStarted = true;
			const accumulator = new OpenAiResponseAccumulator();
			let terminal: ApiResponse | undefined;
			for await (const event of stream) {
				timing.observeResponsesEvent(event);
				if (event.type === "error") throw { error: event };
				if (event.type === "response.failed")
					throw { error: event.response.error };
				accumulator.observeEvent(event);
				if (
					event.type === "response.completed" ||
					event.type === "response.incomplete"
				) {
					terminal = event.response;
					break;
				}
			}
			if (!terminal)
				throw new Error("Responses stream ended before a terminal event");
			const measuredTiming = timing.finish();
			return {
				...toChatInvokeCompletion(accumulator.buildResponse(terminal), {
					transport: "http_stream",
				}),
				...(measuredTiming ? { timing: measuredTiming } : {}),
			};
		} catch (error) {
			if (isProviderFailureError(error)) throw error;
			const failure = input.signal?.aborted
				? buildProviderFailure(this.provider, "cancelled")
				: this.classifyFailure(error);
			throw new ProviderFailureError(
				{
					...failure,
					...(streamStarted ? { retryable: false, delivery: "buffered" } : {}),
				},
				{ cause: error },
			);
		}
	}
}
