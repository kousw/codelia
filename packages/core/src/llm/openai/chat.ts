import OpenAI, { type ClientOptions } from "openai";
import { createHash } from "node:crypto";
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseTextConfig,
} from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";
import {
	OPENAI_DEFAULT_MODEL,
	OPENAI_DEFAULT_REASONING_EFFORT,
} from "../../models/openai";
import type { ChatInvokeCompletion } from "../../types/llm";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../base";
import {
	getProviderLogSettings,
	safeJsonStringify,
	sharedPrefixChars,
	writeProviderLogDump,
} from "../provider-log";
import {
	extractInstructions,
	toChatInvokeCompletion,
	toResponsesInput,
	toResponsesToolChoice,
	toResponsesTools,
} from "./serializer";

const PROVIDER_NAME = "openai" as const;
const DEFAULT_MODEL: string = OPENAI_DEFAULT_MODEL;
const DEFAULT_REASONING_EFFORT: ReasoningEffort =
	OPENAI_DEFAULT_REASONING_EFFORT;
const DEFAULT_REASONING_SUMMARY: "auto" | "concise" | "detailed" = "auto";
type OpenAITextVerbosity = Exclude<ResponseTextConfig["verbosity"], null>;

export type OpenAIInvokeOptions = Omit<
	ResponseCreateParamsBase,
	"model" | "input" | "tools" | "tool_choice" | "stream"
> & {
	reasoningEffort?: ReasoningEffort;
	textVerbosity?: OpenAITextVerbosity;
};

const getSessionIdHeaderValue = (
	promptCacheKey?: string,
): string | undefined => {
	return typeof promptCacheKey === "string" && promptCacheKey.length > 0
		? promptCacheKey
		: undefined;
};

export type ChatOpenAIOptions = {
	client?: OpenAI;
	clientOptions?: ClientOptions;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	textVerbosity?: OpenAITextVerbosity;
};

export class ChatOpenAI
	implements BaseChatModel<typeof PROVIDER_NAME, OpenAIInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly client: OpenAI;
	private readonly defaultReasoningEffort?: ReasoningEffort;
	private readonly defaultTextVerbosity?: OpenAITextVerbosity;
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;

	constructor(options: ChatOpenAIOptions = {}) {
		this.client = options.client ?? new OpenAI(options.clientOptions);
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultReasoningEffort =
			options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
		this.defaultTextVerbosity = options.textVerbosity;
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: OpenAIInvokeOptions },
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
		const inputItems: ResponseInput | string = toResponsesInput(messages);
		const instructions = extractInstructions(messages);
		const tools = toResponsesTools(toolDefs);
		const tool_choice = toResponsesToolChoice(toolChoice);
		const { reasoningEffort, textVerbosity, ...rest } = options ?? {};

		const request: ResponseCreateParamsBase = {
			model: model ?? this.model,
			input: inputItems,
			...rest,
			...(tools ? { tools } : {}),
			...(tool_choice ? { tool_choice } : {}),
		};
		if (request.store === undefined) {
			request.store = false;
		}
		if (instructions) {
			request.instructions = instructions;
		}
		const hasWebSearchTool = tools?.some(
			(tool) =>
				tool.type === "web_search" ||
				tool.type === "web_search_preview" ||
				tool.type === "web_search_preview_2025_03_11",
		);
		const includeSet = new Set(request.include ?? []);
		// stateless restore safety
		includeSet.add("reasoning.encrypted_content");
		if (hasWebSearchTool) {
			includeSet.add("web_search_call.action.sources");
			includeSet.add("web_search_call.results");
		}
		request.include = Array.from(includeSet);
		// reasoning
		const effort = reasoningEffort ?? this.defaultReasoningEffort;
		request.reasoning = { effort, summary: DEFAULT_REASONING_SUMMARY };
		const verbosity = textVerbosity ?? this.defaultTextVerbosity;
		if (verbosity) {
			request.text = {
				...(request.text ?? {}),
				verbosity,
			};
		}
		if (context?.sessionKey && !request.prompt_cache_key) {
			request.prompt_cache_key = context.sessionKey;
		}
		const sessionIdHeader = getSessionIdHeaderValue(request.prompt_cache_key);
		const debugSeq = this.nextDebugInvokeSeq();
		await this.debugRequestIfEnabled(request, debugSeq, sessionIdHeader);
		const streamRequest: ResponseCreateParamsStreaming = {
			...request,
			stream: true,
		};
		const response = await this.client.responses
			.stream(
				streamRequest,
				signal || sessionIdHeader
					? {
							...(signal ? { signal } : {}),
							...(sessionIdHeader
								? {
										headers: {
											session_id: sessionIdHeader,
										},
									}
								: {}),
						}
					: undefined,
			)
			.finalResponse();
		await this.debugResponseIfEnabled(response, debugSeq);
		return toChatInvokeCompletion(response);
	}

	private nextDebugInvokeSeq(): number {
		const seq = this.debugInvokeSeq + 1;
		this.debugInvokeSeq = seq;
		return seq;
	}

	private async debugRequestIfEnabled(
		request: ResponseCreateParamsBase,
		seq: number,
		sessionIdHeader?: string,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) {
			return;
		}
		const payload = safeJsonStringify(request);
		const hash = createHash("sha256").update(payload).digest("hex").slice(0, 16);
		const toolsHash = createHash("sha256")
			.update(safeJsonStringify(request.tools ?? []))
			.digest("hex")
			.slice(0, 12);
		const instructionsHash = createHash("sha256")
			.update(String(request.instructions ?? ""))
			.digest("hex")
			.slice(0, 12);
		const previous = this.lastDebugRequestPayload;
		const shared = previous ? sharedPrefixChars(previous, payload) : payload.length;
		const sharedRatio = payload.length
			? ((shared / payload.length) * 100).toFixed(1)
			: "100.0";
		if (settings.enabled) {
			const sessionHeaderSuffix = sessionIdHeader
				? ` session_id_header=on session_id_hash=${createHash("sha256")
						.update(sessionIdHeader)
						.digest("hex")
						.slice(0, 12)}`
				: " session_id_header=off";
			console.error(
				`[openai.request] seq=${seq} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared} shared_ratio=${sharedRatio}% tools_sha=${toolsHash} instructions_sha=${instructionsHash}${sessionHeaderSuffix}`,
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
						`[openai.request] dump_failed seq=${seq} error=${String(error)}`,
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
		if (!settings.enabled && !settings.dumpDir) {
			return;
		}
		if (settings.enabled) {
			const usage = response.usage;
			const cachedInputTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
			const outputItems = Array.isArray(response.output) ? response.output : [];
			const outputKinds = new Set<string>();
			for (const item of outputItems) {
				const kind =
					item && typeof item === "object" && "type" in item
						? String((item as { type?: unknown }).type ?? "unknown")
						: "unknown";
				outputKinds.add(kind);
			}
			const usageIn = usage?.input_tokens ?? 0;
			console.error(
				`[openai.response] seq=${seq} id=${response.id} status=${response.status} items=${outputItems.length} kinds=${Array.from(outputKinds).join(",")} tok_in=${usageIn} cached_in=${cachedInputTokens}`,
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
						`[openai.response] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
	}
}
