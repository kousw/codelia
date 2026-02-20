import Anthropic from "@anthropic-ai/sdk";
import type {
	Message,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { createHash } from "node:crypto";
import { ANTHROPIC_DEFAULT_MODEL } from "../../models/anthropic";
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
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;

	constructor(options: ChatAnthropicOptions = {}) {
		this.client = options.client ?? new Anthropic(options.clientOptions);
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: AnthropicInvokeOptions },
		_context?: ChatInvokeContext,
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
		const debugSeq = this.nextDebugInvokeSeq();
		await this.debugRequestIfEnabled(request, debugSeq);

		const response = await this.client.messages.create(
			request,
			signal
				? {
						signal,
					}
				: undefined,
		);
		await this.debugResponseIfEnabled(response, debugSeq);
		return toChatInvokeCompletion(response);
	}

	private nextDebugInvokeSeq(): number {
		const seq = this.debugInvokeSeq + 1;
		this.debugInvokeSeq = seq;
		return seq;
	}

	private async debugRequestIfEnabled(
		request: AnthropicMessageCreateParams,
		seq: number,
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
		const systemHash = createHash("sha256")
			.update(safeJsonStringify(request.system ?? ""))
			.digest("hex")
			.slice(0, 12);
		const previous = this.lastDebugRequestPayload;
		const shared = previous ? sharedPrefixChars(previous, payload) : payload.length;
		const sharedRatio = payload.length
			? ((shared / payload.length) * 100).toFixed(1)
			: "100.0";
		if (settings.enabled) {
			console.error(
				`[anthropic.request] seq=${seq} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared} shared_ratio=${sharedRatio}% tools_sha=${toolsHash} system_sha=${systemHash}`,
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
						`[anthropic.request] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
		this.lastDebugRequestPayload = payload;
	}

	private async debugResponseIfEnabled(
		response: Message,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) {
			return;
		}
		if (settings.enabled) {
			const usage = response.usage;
			const inputTokens = usage?.input_tokens ?? 0;
			const outputTokens = usage?.output_tokens ?? 0;
			const cachedRead = usage?.cache_read_input_tokens ?? 0;
			const cachedCreate = usage?.cache_creation_input_tokens ?? 0;
			const blocks = Array.isArray(response.content) ? response.content : [];
			const blockKinds = new Set<string>();
			for (const block of blocks) {
				const kind =
					block && typeof block === "object" && "type" in block
						? String((block as { type?: unknown }).type ?? "unknown")
						: "unknown";
				blockKinds.add(kind);
			}
			console.error(
				`[anthropic.response] seq=${seq} id=${response.id} stop=${String(response.stop_reason ?? "unknown")} blocks=${blocks.length} kinds=${Array.from(blockKinds).join(",")} tok_in=${inputTokens} tok_out=${outputTokens} cache_read=${cachedRead} cache_create=${cachedCreate}`,
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
						`[anthropic.response] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
	}
}
