import { createHash } from "node:crypto";
import type { ModelReasoningLevel } from "@codelia/shared-types";
import OpenAI, { type ClientOptions } from "openai";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions/completions";
import { MOONSHOT_DEFAULT_MODEL } from "../../models/moonshot";
import type { ChatInvokeCompletion } from "../../types/llm";
import type { BaseChatModel, ChatInvokeInput } from "../base";
import {
	getProviderLogSettings,
	safeJsonStringify,
	sharedPrefixChars,
	writeProviderLogDump,
} from "../provider-log";
import {
	appendMoonshotChatCompletionChunk,
	createMoonshotStreamAccumulator,
	type MoonshotChatCompletionChunk,
	toMoonshotChatInvokeCompletion,
	toMoonshotMessages,
	toMoonshotToolChoice,
	toMoonshotTools,
} from "./serializer";

const PROVIDER_NAME = "moonshot" as const;
const DEFAULT_BASE_URL = "https://api.moonshot.ai/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type MoonshotInvokeOptions = {
	max_completion_tokens?: number;
	response_format?: unknown;
};

export type ChatMoonshotOptions = {
	apiKey?: string;
	baseURL?: string;
	fetch?: typeof fetch;
	model?: string;
	timeoutMs?: number;
	reasoningLevelRequested?: ModelReasoningLevel;
};

type MoonshotRequest = {
	model: string;
	messages: ReturnType<typeof toMoonshotMessages>;
	stream: true;
	stream_options: { include_usage: true };
	reasoning_effort: "max";
	tools?: ReturnType<typeof toMoonshotTools>;
	tool_choice?: ReturnType<typeof toMoonshotToolChoice>;
	max_completion_tokens?: number;
	response_format?: unknown;
};

export class ChatMoonshot
	implements BaseChatModel<typeof PROVIDER_NAME, MoonshotInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly apiKey?: string;
	private readonly clientOptions: Omit<ClientOptions, "apiKey">;
	private readonly reasoningLevelRequested: ModelReasoningLevel;
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;

	constructor(options: ChatMoonshotOptions = {}) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? MOONSHOT_DEFAULT_MODEL;
		this.reasoningLevelRequested = options.reasoningLevelRequested ?? "medium";
		this.clientOptions = {
			baseURL: (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
			timeout: options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			...(options.fetch ? { fetch: options.fetch } : {}),
		};
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: MoonshotInvokeOptions },
	): Promise<ChatInvokeCompletion> {
		if (!this.apiKey) {
			throw new Error("Moonshot API key is required");
		}
		const tools = toMoonshotTools(input.tools);
		const toolChoice = toMoonshotToolChoice(input.toolChoice);
		const request: MoonshotRequest = {
			model: input.model ?? this.model,
			messages: toMoonshotMessages(input.messages),
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: "max",
			...(input.options ?? {}),
			...(tools ? { tools } : {}),
			...(toolChoice ? { tool_choice: toolChoice } : {}),
		};
		const seq = this.nextDebugInvokeSeq();
		await this.debugRequestIfEnabled(request, seq);
		const client = new OpenAI({ apiKey: this.apiKey, ...this.clientOptions });
		const accumulator = createMoonshotStreamAccumulator();
		try {
			const stream = await client.chat.completions.create(
				request as ChatCompletionCreateParamsStreaming,
				{ signal: input.signal },
			);
			for await (const chunk of stream) {
				appendMoonshotChatCompletionChunk(
					accumulator,
					chunk as MoonshotChatCompletionChunk,
				);
			}
		} catch (error) {
			throw toMoonshotError(error);
		}
		await this.debugResponseIfEnabled(accumulator, seq);
		return toMoonshotChatInvokeCompletion(accumulator, {
			reasoningRequested: this.reasoningLevelRequested,
			reasoningFallback: this.reasoningLevelRequested !== "max",
		});
	}

	private nextDebugInvokeSeq(): number {
		this.debugInvokeSeq += 1;
		return this.debugInvokeSeq;
	}

	private async debugRequestIfEnabled(
		request: MoonshotRequest,
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
		if (settings.enabled) {
			console.error(
				`[moonshot.request] seq=${seq} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared}`,
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
						`[moonshot.request] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
		this.lastDebugRequestPayload = payload;
	}

	private async debugResponseIfEnabled(
		response: ReturnType<typeof createMoonshotStreamAccumulator>,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) return;
		if (settings.enabled) {
			console.error(
				`[moonshot.response] seq=${seq} id=${response.id ?? "unknown"} chunks=${response.rawChunkCount} finish=${response.finishReason ?? "unknown"} tok_in=${response.usage?.prompt_tokens ?? 0} tok_out=${response.usage?.completion_tokens ?? 0}`,
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
						`[moonshot.response] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
	}
}

const toMoonshotError = (error: unknown): Error => {
	if (error instanceof OpenAI.APIError) {
		const prefix =
			error.status === 401 || error.status === 403
				? "Moonshot auth/config error"
				: error.status === 429 || (error.status ?? 0) >= 500
					? "Moonshot transient/rate-limit error"
					: "Moonshot provider error";
		return new Error(
			`${prefix} (${error.status ?? "unknown"}): ${error.message}`,
		);
	}
	if (error instanceof Error) return error;
	return new Error(`Moonshot provider error: ${String(error)}`);
};

export type { MoonshotChatCompletionChunk, MoonshotUsage } from "./serializer";
