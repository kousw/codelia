import OpenAI, { type ClientOptions } from "openai";
import type {
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
import type { BaseChatModel, ChatInvokeInput } from "../base";
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

	constructor(options: ChatOpenAIOptions = {}) {
		this.client = options.client ?? new OpenAI(options.clientOptions);
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultReasoningEffort =
			options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
		this.defaultTextVerbosity = options.textVerbosity;
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: OpenAIInvokeOptions },
		verbose: boolean = false,
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
		if (verbose) {
			console.debug(request);
		}
		const streamRequest: ResponseCreateParamsStreaming = {
			...request,
			stream: true,
		};
		const response = await this.client.responses
			.stream(
				streamRequest,
				signal
					? {
							signal,
						}
					: undefined,
			)
			.finalResponse();
		if (verbose) {
			console.debug(response);
		}
		return toChatInvokeCompletion(response);
	}
}
