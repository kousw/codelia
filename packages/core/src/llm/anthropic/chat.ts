import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { ANTHROPIC_DEFAULT_MODEL } from "../../models/anthropic";
import type { ChatInvokeCompletion } from "../../types/llm";
import type { BaseChatModel, ChatInvokeInput } from "../base";
import {
	toAnthropicMessages,
	toAnthropicToolChoice,
	toAnthropicTools,
	toChatInvokeCompletion,
} from "./serializer";

const PROVIDER_NAME = "anthropic" as const;
const DEFAULT_MODEL: string = ANTHROPIC_DEFAULT_MODEL;
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicMessageCreateParams = MessageCreateParamsNonStreaming;

export type AnthropicInvokeOptions = Omit<
	AnthropicMessageCreateParams,
	"model" | "messages" | "tools" | "tool_choice" | "system" | "stream"
>;

export type ChatAnthropicOptions = {
	client?: Anthropic;
	clientOptions?: ConstructorParameters<typeof Anthropic>[0];
	model?: string;
	maxTokens?: number;
};

export class ChatAnthropic
	implements BaseChatModel<typeof PROVIDER_NAME, AnthropicInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly client: Anthropic;
	private readonly defaultMaxTokens: number;

	constructor(options: ChatAnthropicOptions = {}) {
		this.client = options.client ?? new Anthropic(options.clientOptions);
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: AnthropicInvokeOptions },
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
		const { system, messages: anthropicMessages } =
			toAnthropicMessages(messages);
		const enableTools = toolChoice !== "none";
		const tools = enableTools ? toAnthropicTools(toolDefs) : undefined;
		const tool_choice = enableTools
			? toAnthropicToolChoice(toolChoice)
			: undefined;
		const { max_tokens, ...rest } = options ?? {};

		const request: AnthropicMessageCreateParams = {
			model: model ?? this.model,
			max_tokens: max_tokens ?? this.defaultMaxTokens,
			messages: anthropicMessages as AnthropicMessageCreateParams["messages"],
			...rest,
			...(system ? { system } : {}),
			...(tools ? { tools } : {}),
			...(tool_choice ? { tool_choice } : {}),
		};

		if (verbose) {
			console.debug(request);
		}

		const response = await this.client.messages.create(
			request,
			signal
				? {
						signal,
					}
				: undefined,
		);
		if (verbose) {
			console.debug(response);
		}
		return toChatInvokeCompletion(response);
	}
}
