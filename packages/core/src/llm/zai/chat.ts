import { createHash } from "node:crypto";
import { ZAI_DEFAULT_MODEL } from "../../models/zai";
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
	toZaiChatInvokeCompletion,
	toZaiMessages,
	toZaiToolChoice,
	toZaiTools,
	type ZaiUsage,
} from "./serializer";
import {
	streamZaiChatCompletion,
	type ZaiChatCompletionRequest,
	type ZaiReasoningEffort,
	type ZaiStreamTerminalResponse,
} from "./transport";

const PROVIDER_NAME = "zai" as const;
const DEFAULT_BASE_URL = "https://api.z.ai/api/paas/v4";
const DEFAULT_REASONING_EFFORT = "high" as const;
const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

export type ZaiInvokeOptions = {
	max_tokens?: number;
	temperature?: number;
	top_p?: number;
	reasoningEffort?: ZaiReasoningEffort | null;
	[key: string]: unknown;
};

export type ChatZaiOptions = {
	apiKey?: string;
	baseURL?: string;
	fetch?: typeof fetch;
	model?: string;
	timeoutMs?: number | null;
	reasoningEffort?: ZaiReasoningEffort | null;
	reasoningLevelRequested?: "low" | "medium" | "high" | "xhigh";
	reasoningLevelApplied?: "high" | "xhigh";
	reasoningFallbackApplied?: boolean;
};

export class ChatZai
	implements BaseChatModel<typeof PROVIDER_NAME, ZaiInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly apiKey?: string;
	private readonly baseURL: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number | null;
	private readonly defaultReasoningEffort: ZaiReasoningEffort | null;
	private readonly reasoningLevelMeta: {
		requested?: "low" | "medium" | "high" | "xhigh";
		applied?: "high" | "xhigh";
		fallbackApplied?: boolean;
	};
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;

	constructor(options: ChatZaiOptions = {}) {
		this.apiKey = options.apiKey;
		this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = options.fetch ?? fetch;
		this.model = options.model ?? ZAI_DEFAULT_MODEL;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.defaultReasoningEffort =
			options.reasoningEffort === undefined
				? DEFAULT_REASONING_EFFORT
				: options.reasoningEffort;
		this.reasoningLevelMeta = {
			requested: options.reasoningLevelRequested,
			applied: options.reasoningLevelApplied,
			fallbackApplied: options.reasoningFallbackApplied,
		};
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: ZaiInvokeOptions },
		// Z.ai phase 1 has no confirmed prompt-cache/session routing hint.
		_context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion> {
		const apiKey = this.apiKey;
		if (!apiKey) {
			throw new Error("Z.ai API key is required");
		}
		const {
			messages,
			tools: toolDefs,
			toolChoice,
			options,
			model,
			signal,
		} = input;
		const { reasoningEffort, ...rest } = options ?? {};
		const effectiveReasoningEffort =
			reasoningEffort === undefined
				? this.defaultReasoningEffort
				: reasoningEffort;
		const tools = toZaiTools(toolDefs);
		const toolChoiceParam = toZaiToolChoice(toolChoice);
		const request: ZaiChatCompletionRequest = {
			model: model ?? this.model,
			messages: toZaiMessages(messages),
			stream: true,
			thinking: { type: "enabled" },
			...rest,
			...(effectiveReasoningEffort
				? { reasoning_effort: effectiveReasoningEffort }
				: {}),
			...(tools ? { tools } : {}),
			...(tools ? { tool_stream: true } : {}),
			...(toolChoiceParam ? { tool_choice: toolChoiceParam } : {}),
		};
		const debugSeq = this.nextDebugInvokeSeq();
		await this.debugRequestIfEnabled(request, debugSeq);
		const terminal = await this.streamRequest(apiKey, request, signal);
		await this.debugResponseIfEnabled(terminal, debugSeq);
		return toZaiChatInvokeCompletion(terminal.accumulated, {
			request_id: terminal.request_id ?? null,
			reasoning_requested: this.reasoningLevelMeta.requested,
			reasoning_applied: this.reasoningLevelMeta.applied,
			reasoning_effort: request.reasoning_effort,
			reasoning_fallback: this.reasoningLevelMeta.fallbackApplied,
		});
	}

	private async streamRequest(
		apiKey: string,
		request: ZaiChatCompletionRequest,
		signal?: AbortSignal,
	): Promise<ZaiStreamTerminalResponse> {
		const logSettings = getProviderLogSettings();
		return streamZaiChatCompletion({
			apiKey,
			baseURL: this.baseURL,
			fetchImpl: this.fetchImpl,
			request,
			signal,
			timeoutMs: this.timeoutMs,
			captureRawChunks: Boolean(logSettings.dumpDir),
		});
	}

	private nextDebugInvokeSeq(): number {
		const seq = this.debugInvokeSeq + 1;
		this.debugInvokeSeq = seq;
		return seq;
	}

	private async debugRequestIfEnabled(
		request: ZaiChatCompletionRequest,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) {
			return;
		}
		const payload = safeJsonStringify(request);
		const hash = createHash("sha256")
			.update(payload)
			.digest("hex")
			.slice(0, 16);
		const toolsHash = createHash("sha256")
			.update(safeJsonStringify(request.tools ?? []))
			.digest("hex")
			.slice(0, 12);
		const previous = this.lastDebugRequestPayload;
		const shared = previous
			? sharedPrefixChars(previous, payload)
			: payload.length;
		const sharedRatio = payload.length
			? ((shared / payload.length) * 100).toFixed(1)
			: "100.0";
		if (settings.enabled) {
			console.error(
				`[zai.request] seq=${seq} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared} shared_ratio=${sharedRatio}% tools_sha=${toolsHash}`,
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
						`[zai.request] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
		this.lastDebugRequestPayload = payload;
	}

	private async debugResponseIfEnabled(
		response: ZaiStreamTerminalResponse,
		seq: number,
	): Promise<void> {
		const settings = getProviderLogSettings();
		if (!settings.enabled && !settings.dumpDir) {
			return;
		}
		const usage = response.accumulated.usage;
		if (settings.enabled) {
			const inputTokens = usage?.prompt_tokens ?? 0;
			const outputTokens = usage?.completion_tokens ?? 0;
			console.error(
				`[zai.response] seq=${seq} id=${response.accumulated.id ?? "unknown"} status=${response.status} chunks=${response.accumulated.rawChunkCount} finish=${String(response.accumulated.finishReason ?? "unknown")} tok_in=${inputTokens} tok_out=${outputTokens}`,
			);
		}
		if (settings.dumpDir) {
			try {
				await writeProviderLogDump(
					settings,
					PROVIDER_NAME,
					seq,
					"response",
					response.accumulated,
				);
			} catch (error) {
				if (settings.enabled) {
					console.error(
						`[zai.response] dump_failed seq=${seq} error=${String(error)}`,
					);
				}
			}
		}
	}
}

export type { ZaiChatCompletionChunk } from "./serializer";
export type { ZaiReasoningEffort, ZaiUsage };
