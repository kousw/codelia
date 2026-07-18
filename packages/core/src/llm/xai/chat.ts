import { createHash } from "node:crypto";
import type { ModelReasoningLevel } from "@codelia/shared-types";
import OpenAI, { type ClientOptions } from "openai";
import type {
	Response,
	ResponseCreateParamsBase,
} from "openai/resources/responses/responses";
import {
	XAI_DEFAULT_MODEL,
	XAI_DEFAULT_REASONING_EFFORT,
} from "../../models/xai";
import type { ChatInvokeCompletion } from "../../types/llm";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../base";
import { invokeOpenAiHttp } from "../openai/http-transport";
import { extractInstructions } from "../openai/serializer";
import {
	getProviderLogSettings,
	safeJsonStringify,
	sharedPrefixChars,
	writeProviderLogDump,
} from "../provider-log";
import {
	toXaiChatInvokeCompletion,
	toXaiResponsesInput,
	toXaiResponsesToolChoice,
	toXaiResponsesTools,
} from "./serializer";

const PROVIDER_NAME = "xai" as const;
const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export type XaiReasoningEffort = "low" | "medium" | "high";

export type XaiInvokeOptions = Omit<
	ResponseCreateParamsBase,
	"model" | "input" | "tools" | "tool_choice" | "stream" | "reasoning"
> & {
	reasoningEffort?: XaiReasoningEffort;
};

type ReasoningLevelMeta = {
	requested?: ModelReasoningLevel;
	applied?: ModelReasoningLevel;
	fallbackApplied?: boolean;
};

export type ChatXaiOptions = {
	client?: OpenAI;
	clientOptions?: ClientOptions;
	model?: string;
	reasoningEffort?: XaiReasoningEffort;
	reasoningLevelRequested?: ModelReasoningLevel;
	reasoningLevelApplied?: ModelReasoningLevel;
	reasoningFallbackApplied?: boolean;
};

export class ChatXai
	implements BaseChatModel<typeof PROVIDER_NAME, XaiInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly client: OpenAI;
	private readonly defaultReasoningEffort: XaiReasoningEffort;
	private readonly reasoningLevelMeta: ReasoningLevelMeta;
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;

	constructor(options: ChatXaiOptions = {}) {
		this.client =
			options.client ??
			new OpenAI({
				baseURL: XAI_BASE_URL,
				timeout: DEFAULT_REQUEST_TIMEOUT_MS,
				...(options.clientOptions ?? {}),
			});
		this.model = options.model ?? XAI_DEFAULT_MODEL;
		this.defaultReasoningEffort =
			options.reasoningEffort ?? XAI_DEFAULT_REASONING_EFFORT;
		this.reasoningLevelMeta = {
			requested: options.reasoningLevelRequested,
			applied: options.reasoningLevelApplied,
			fallbackApplied: options.reasoningFallbackApplied,
		};
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: XaiInvokeOptions },
		context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion> {
		const {
			messages,
			tools: toolDefs,
			toolChoice,
			options,
			model,
			signal,
		} = input;
		const inputItems = toXaiResponsesInput(messages);
		const instructions = extractInstructions(messages);
		const tools = toXaiResponsesTools(toolDefs);
		const tool_choice = toXaiResponsesToolChoice(toolChoice);
		const { reasoningEffort, ...rest } = options ?? {};
		const request: ResponseCreateParamsBase = {
			model: model ?? this.model,
			input: inputItems as ResponseCreateParamsBase["input"],
			...rest,
			...(tools ? { tools } : {}),
			...(tool_choice ? { tool_choice } : {}),
			store: rest.store ?? false,
			reasoning: {
				effort: reasoningEffort ?? this.defaultReasoningEffort,
			},
		};
		if (instructions) {
			request.instructions = instructions;
		}
		const includeSet = new Set(request.include ?? []);
		includeSet.add("reasoning.encrypted_content");
		if (tools?.some((tool) => tool.type === "web_search")) {
			includeSet.add("web_search_call.action.sources");
		}
		request.include = Array.from(includeSet);
		if (context?.sessionKey && !request.prompt_cache_key) {
			request.prompt_cache_key = context.sessionKey;
		}

		const debugSeq = this.nextDebugInvokeSeq();
		await this.debugRequestIfEnabled(request, debugSeq);
		const response = await invokeOpenAiHttp(this.client, request, signal);
		await this.debugResponseIfEnabled(response, debugSeq);
		return toXaiChatInvokeCompletion(response, {
			reasoning_requested: this.reasoningLevelMeta.requested,
			reasoning_applied: this.reasoningLevelMeta.applied,
			reasoning_fallback: this.reasoningLevelMeta.fallbackApplied,
		});
	}

	private nextDebugInvokeSeq(): number {
		this.debugInvokeSeq += 1;
		return this.debugInvokeSeq;
	}

	private async debugRequestIfEnabled(
		request: ResponseCreateParamsBase,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) return;
		const payload = safeJsonStringify(request);
		const hash = createHash("sha256")
			.update(payload)
			.digest("hex")
			.slice(0, 16);
		const previous = this.lastDebugRequestPayload;
		const shared = previous
			? sharedPrefixChars(previous, payload)
			: payload.length;
		const ratio = payload.length
			? ((shared / payload.length) * 100).toFixed(1)
			: "100.0";
		if (settings.enabled) {
			console.error(
				`[xai.request] seq=${seq} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared} shared_ratio=${ratio}%`,
			);
		}
		if (settings.dumpDir) {
			try {
				await writeProviderLogDump(
					settings,
					PROVIDER_NAME,
					seq,
					"request",
					request,
				);
			} catch (error) {
				if (settings.enabled) {
					console.error(
						`[xai.request] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
		this.lastDebugRequestPayload = payload;
	}

	private async debugResponseIfEnabled(
		response: Response,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) return;
		if (settings.enabled) {
			console.error(
				`[xai.response] seq=${seq} id=${response.id} status=${response.status} items=${response.output.length} tok_in=${response.usage?.input_tokens ?? 0} cached_in=${response.usage?.input_tokens_details?.cached_tokens ?? 0} tok_out=${response.usage?.output_tokens ?? 0}`,
			);
		}
		if (settings.dumpDir) {
			try {
				await writeProviderLogDump(
					settings,
					PROVIDER_NAME,
					seq,
					"response",
					response,
				);
			} catch (error) {
				if (settings.enabled) {
					console.error(
						`[xai.response] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
	}
}
