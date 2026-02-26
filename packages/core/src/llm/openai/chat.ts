import { createHash } from "node:crypto";
import OpenAI, { type ClientOptions } from "openai";
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseInput,
	ResponseTextConfig,
} from "openai/resources/responses/responses";
import type { ResponsesWS } from "openai/resources/responses/ws";
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
import { invokeOpenAiHttp } from "./http-transport";
import type {
	OpenAiRequestMeta,
	OpenAiResponsesWsLike,
	OpenAiTransportInvokeResult as TransportInvokeResult,
	OpenAiWsExecutionPlan,
	OpenAiWebsocketApiVersion,
	OpenAiWebsocketMode,
	OpenAiWsInputMode,
	WsConversationState,
} from "./transport-types";
import { OpenAiWsTransport } from "./websocket-transport";

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

const WS_SESSION_IDLE_TTL_MS = 10 * 60_000;
const WS_SESSION_DISABLE_TTL_MS = 60_000;
const WS_REUSE_MAX_IDLE_MS = 30_000;
const WS_ON_MODE_RETRY_MAX_ATTEMPTS = 3;
const WS_ON_MODE_RETRY_BASE_BACKOFF_MS = 250;
const WS_ON_MODE_RETRY_MAX_BACKOFF_MS = 2_000;

export type { OpenAiWebsocketApiVersion, OpenAiWebsocketMode } from "./transport-types";

export type ChatOpenAIOptions = {
	client?: OpenAI;
	clientOptions?: ClientOptions;
	model?: string;
	reasoningEffort?: ReasoningEffort;
	textVerbosity?: OpenAITextVerbosity;
	websocketMode?: OpenAiWebsocketMode;
	websocketApiVersion?: OpenAiWebsocketApiVersion;
	createResponsesWs?: (
		client: OpenAI,
		options?: ConstructorParameters<typeof ResponsesWS>[1],
	) => OpenAiResponsesWsLike;
	websocketConnectTimeoutMs?: number;
	websocketResponseIdleTimeoutMs?: number;
};

export class ChatOpenAI
	implements BaseChatModel<typeof PROVIDER_NAME, OpenAIInvokeOptions>
{
	readonly provider: typeof PROVIDER_NAME = PROVIDER_NAME;
	readonly model: string;
	private readonly client: OpenAI;
	private readonly defaultReasoningEffort?: ReasoningEffort;
	private readonly defaultTextVerbosity?: OpenAITextVerbosity;
	private readonly websocketMode: OpenAiWebsocketMode;
	private readonly websocketApiVersion: OpenAiWebsocketApiVersion;
	private readonly wsTransport: OpenAiWsTransport;
	private debugInvokeSeq = 0;
	private lastDebugRequestPayload: string | null = null;
	private readonly wsStateBySessionKey = new Map<string, WsConversationState>();
	private readonly wsDisabledUntilBySessionKey = new Map<string, number>();
	private wsReconnectCount = 0;

	constructor(options: ChatOpenAIOptions = {}) {
		this.client = options.client ?? new OpenAI(options.clientOptions);
		this.model = options.model ?? DEFAULT_MODEL;
		this.defaultReasoningEffort =
			options.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
		this.defaultTextVerbosity = options.textVerbosity;
		this.websocketMode = options.websocketMode ?? "off";
		this.websocketApiVersion = options.websocketApiVersion ?? "v2";
		this.wsTransport = new OpenAiWsTransport({
			client: this.client,
			websocketApiVersion: this.websocketApiVersion,
			createResponsesWs: options.createResponsesWs,
			wsConnectTimeoutMs: options.websocketConnectTimeoutMs,
			wsResponseIdleTimeoutMs: options.websocketResponseIdleTimeoutMs,
		});
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
		const requestMeta = {
			model: String(request.model ?? this.model),
			instructionsHash: createHash("sha256")
				.update(String(request.instructions ?? ""))
				.digest("hex")
				.slice(0, 12),
			toolsHash: createHash("sha256")
				.update(safeJsonStringify(request.tools ?? []))
				.digest("hex")
				.slice(0, 12),
		};
		const transportResult = await this.invokeWithTransport({
			request,
			sessionKey: context?.sessionKey,
			sessionIdHeader,
			signal,
			debugSeq,
			requestMeta,
		});
		await this.debugResponseIfEnabled(
			transportResult.response,
			debugSeq,
			transportResult.transport,
		);
		return toChatInvokeCompletion(transportResult.response, {
			transport: transportResult.transport,
			websocket_mode: this.websocketMode,
			fallback_used: transportResult.fallbackUsed,
			chain_reset: transportResult.chainReset,
			ws_reconnect_count: this.wsReconnectCount,
			ws_input_mode: transportResult.wsInputMode,
		});
	}

	private async invokeWithTransport(args: {
		request: ResponseCreateParamsBase;
		sessionKey?: string;
		sessionIdHeader?: string;
		signal?: AbortSignal;
		debugSeq: number;
		requestMeta: OpenAiRequestMeta;
	}): Promise<TransportInvokeResult> {
		this.evictIdleWsSessionState();
		if (this.websocketMode === "off") {
			return this.invokeHttpTransportWithDebug({
				request: args.request,
				debugSeq: args.debugSeq,
				sessionIdHeader: args.sessionIdHeader,
				signal: args.signal,
				fallbackUsed: false,
				chainReset: false,
			});
		}
		if (!args.sessionKey) {
			if (this.websocketMode === "on") {
				throw new Error(
					"openai websocket_mode=on requires a session key for stable chaining",
				);
			}
			return this.invokeHttpTransportWithDebug({
				request: args.request,
				debugSeq: args.debugSeq,
				sessionIdHeader: args.sessionIdHeader,
				signal: args.signal,
				fallbackUsed: false,
				chainReset: false,
			});
		}
		if (this.isWsSessionDisabled(args.sessionKey)) {
			return this.invokeHttpTransportWithDebug({
				request: args.request,
				debugSeq: args.debugSeq,
				sessionIdHeader: args.sessionIdHeader,
				signal: args.signal,
				fallbackUsed: true,
				chainReset: true,
			});
		}
		const wsState = this.wsStateBySessionKey.get(args.sessionKey) ?? {};
		const hasReusableWs =
			this.isWsConnectionReusable(wsState.ws) &&
			!this.isWsConnectionReuseExpired(wsState.lastUsedAt);
		const shouldResetChain =
			wsState.model !== args.requestMeta.model ||
			wsState.instructionsHash !== args.requestMeta.instructionsHash ||
			wsState.toolsHash !== args.requestMeta.toolsHash ||
			(Boolean(wsState.ws) && !hasReusableWs);
		const incrementalInput = this.getIncrementalInput(
			wsState.lastInput,
			args.request.input,
		);
		const canUsePreviousResponseId =
			this.websocketApiVersion === "v2" &&
			Boolean(wsState.previousResponseId) &&
			!shouldResetChain &&
			incrementalInput !== null;
		const chainReset =
			shouldResetChain ||
			(Boolean(wsState.previousResponseId) && !canUsePreviousResponseId);
		let wsInputMode: OpenAiWsInputMode = "full_no_previous";
		if (wsState.previousResponseId) {
			if (canUsePreviousResponseId) {
				if (Array.isArray(incrementalInput) && incrementalInput.length === 0) {
					wsInputMode = "empty";
				} else {
					wsInputMode = "incremental";
				}
			} else {
				wsInputMode = "full_regenerated";
			}
		}
		const fallbackAllowed = this.websocketMode === "auto";
		const wsExecutionPlan: OpenAiWsExecutionPlan = {
			request: {
				...args.request,
				...(canUsePreviousResponseId
					? { previous_response_id: wsState.previousResponseId }
					: {}),
				...(canUsePreviousResponseId && incrementalInput !== undefined
					? { input: incrementalInput }
					: {}),
			},
			chainReset,
			wsInputMode,
			requiresWsConnectionReset:
				Boolean(wsState.ws) &&
				(!hasReusableWs ||
					(Boolean(wsState.previousResponseId) && !canUsePreviousResponseId)),
			hasReusableWs,
		};
		try {
			if (wsExecutionPlan.requiresWsConnectionReset) {
				this.closeWsSafely(
					wsState.ws,
					hasReusableWs ? "chain_reset" : "stale_connection",
				);
			}
			await this.debugRequestIfEnabled(
				wsExecutionPlan.request,
				args.debugSeq,
				args.sessionIdHeader,
				"ws_mode",
				false,
				wsExecutionPlan.chainReset,
				wsExecutionPlan.wsInputMode,
			);
			const { response, ws } = await this.invokeViaWs({
				request: wsExecutionPlan.request,
				signal: args.signal,
				sessionIdHeader: args.sessionIdHeader,
				ws:
					wsExecutionPlan.requiresWsConnectionReset ||
					!wsExecutionPlan.hasReusableWs
						? undefined
						: wsState.ws,
			});
			this.persistWsSessionState({
				sessionKey: args.sessionKey,
				request: args.request,
				requestMeta: args.requestMeta,
				response,
				ws,
			});
			return {
				response,
				transport: "ws_mode",
				fallbackUsed: false,
				chainReset: wsExecutionPlan.chainReset,
				wsInputMode: wsExecutionPlan.wsInputMode,
			};
		} catch (error) {
			let failure: unknown = error;
			if (
				this.websocketMode === "on" &&
				this.isWsReconnectRetryableError(failure)
			) {
				const retryWsInputMode: OpenAiWsInputMode = wsState.previousResponseId
					? "full_regenerated"
					: "full_no_previous";
				this.closeWsWithoutMaskingPrimaryError(wsState.ws, "retry_reset", failure);
				for (
					let retryAttempt = 1;
					retryAttempt <= WS_ON_MODE_RETRY_MAX_ATTEMPTS;
					retryAttempt += 1
				) {
					try {
						await this.waitForWsReconnectRetryDelay(
							retryAttempt,
							args.signal,
						);
						await this.debugRequestIfEnabled(
							args.request,
							args.debugSeq,
							args.sessionIdHeader,
							"ws_mode",
							false,
							true,
							retryWsInputMode,
						);
						const { response, ws } = await this.invokeViaWs({
							request: args.request,
							signal: args.signal,
							sessionIdHeader: args.sessionIdHeader,
							ws: undefined,
						});
						this.wsReconnectCount += retryAttempt;
						this.persistWsSessionState({
							sessionKey: args.sessionKey,
							request: args.request,
							requestMeta: args.requestMeta,
							response,
							ws,
						});
						return {
							response,
							transport: "ws_mode",
							fallbackUsed: false,
							chainReset: true,
							wsInputMode: retryWsInputMode,
						};
					} catch (retryError) {
						failure = retryError;
						if (!this.isWsReconnectRetryableError(failure)) {
							break;
						}
					}
				}
			}
			const wsErrorCode = this.extractWsErrorCode(failure);
			const wsErrorMessage =
				failure instanceof Error ? failure.message.toLowerCase() : "";
			const shouldDisableWsForSession =
				wsErrorCode === "previous_response_not_found" ||
				wsErrorMessage.includes("previous_response_not_found") ||
				wsErrorMessage.includes("could not send data") ||
				wsErrorMessage.includes("unexpected server response") ||
				wsErrorMessage.includes("response timeout") ||
				wsErrorMessage.includes("closed before response") ||
				wsErrorMessage.includes("closed before open");
			this.clearWsSessionState(args.sessionKey, "reset", failure);
			if (shouldDisableWsForSession && fallbackAllowed) {
				this.wsDisabledUntilBySessionKey.set(
					args.sessionKey,
					Date.now() + WS_SESSION_DISABLE_TTL_MS,
				);
			}
			if (!fallbackAllowed) {
				throw failure;
			}
			this.wsReconnectCount += 1;
			return this.invokeHttpTransportWithDebug({
				request: args.request,
				debugSeq: args.debugSeq,
				sessionIdHeader: args.sessionIdHeader,
				signal: args.signal,
				fallbackUsed: true,
				chainReset: true,
				wsInputMode: wsExecutionPlan.wsInputMode,
			});
		}
	}

	private async invokeHttpTransportWithDebug(args: {
		request: ResponseCreateParamsBase;
		debugSeq: number;
		sessionIdHeader?: string;
		signal?: AbortSignal;
		fallbackUsed: boolean;
		chainReset: boolean;
		wsInputMode?: OpenAiWsInputMode;
	}): Promise<TransportInvokeResult> {
		await this.debugRequestIfEnabled(
			args.request,
			args.debugSeq,
			args.sessionIdHeader,
			"http_stream",
			args.fallbackUsed,
			args.chainReset,
			args.wsInputMode,
		);
		const response = await invokeOpenAiHttp(
			this.client,
			args.request,
			args.signal,
			args.sessionIdHeader,
		);
		return {
			response,
			transport: "http_stream",
			fallbackUsed: args.fallbackUsed,
			chainReset: args.chainReset,
		};
	}

	private persistWsSessionState(args: {
		sessionKey: string;
		request: ResponseCreateParamsBase;
		requestMeta: OpenAiRequestMeta;
		response: Response;
		ws: OpenAiResponsesWsLike;
	}): void {
		this.wsDisabledUntilBySessionKey.delete(args.sessionKey);
		this.wsStateBySessionKey.set(args.sessionKey, {
			previousResponseId: args.response.id,
			instructionsHash: args.requestMeta.instructionsHash,
			toolsHash: args.requestMeta.toolsHash,
			model: args.requestMeta.model,
			lastInput: args.request.input,
			ws: args.ws,
			lastUsedAt: Date.now(),
		});
	}

	private async invokeViaWs(args: {
		request: ResponseCreateParamsBase;
		signal?: AbortSignal;
		sessionIdHeader?: string;
		ws?: OpenAiResponsesWsLike;
	}): Promise<{ response: Response; ws: OpenAiResponsesWsLike }> {
		return this.wsTransport.invoke(args);
	}

	private closeWsSafely(
		ws: OpenAiResponsesWsLike | undefined,
		reason: string,
	): void {
		this.wsTransport.closeSafely(ws, reason);
	}

	private closeWsWithoutMaskingPrimaryError(
		ws: OpenAiResponsesWsLike | undefined,
		reason: string,
		primaryError?: unknown,
	): void {
		this.wsTransport.closeWithoutMaskingPrimaryError(ws, reason, primaryError);
	}

	private isWsConnectionReuseExpired(lastUsedAt: number | undefined): boolean {
		if (typeof lastUsedAt !== "number") {
			return false;
		}
		return Date.now() - lastUsedAt > WS_REUSE_MAX_IDLE_MS;
	}

	private isWsReconnectRetryableError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false;
		}
		const message = error.message.toLowerCase();
		return (
			message.includes("response timeout") ||
			message.includes("closed before response") ||
			message.includes("closed before open") ||
			message.includes("connect timeout") ||
			message.includes("could not send data") ||
			message.includes("websocket is not open")
		);
	}

	private getWsReconnectRetryDelayMs(retryAttempt: number): number {
		const backoff =
			WS_ON_MODE_RETRY_BASE_BACKOFF_MS * 2 ** Math.max(retryAttempt - 1, 0);
		return Math.min(backoff, WS_ON_MODE_RETRY_MAX_BACKOFF_MS);
	}

	private async waitForWsReconnectRetryDelay(
		retryAttempt: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) {
			throw new Error("openai websocket request aborted");
		}
		const delayMs = this.getWsReconnectRetryDelayMs(retryAttempt);
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				teardown();
				resolve();
			}, delayMs);
			const onAbort = (): void => {
				teardown();
				reject(new Error("openai websocket request aborted"));
			};
			const teardown = (): void => {
				clearTimeout(timeout);
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
			};
			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	private isWsConnectionReusable(ws: OpenAiResponsesWsLike | undefined): boolean {
		return this.wsTransport.isConnectionReusable(ws);
	}

	private extractWsErrorCode(error: unknown): string | undefined {
		return this.wsTransport.extractErrorCode(error);
	}

	private clearWsSessionState(
		sessionKey: string,
		reason: string,
		primaryError?: unknown,
	): void {
		const state = this.wsStateBySessionKey.get(sessionKey);
		if (primaryError === undefined) {
			this.closeWsSafely(state?.ws, reason);
		} else {
			this.closeWsWithoutMaskingPrimaryError(state?.ws, reason, primaryError);
		}
		this.wsStateBySessionKey.delete(sessionKey);
	}

	private evictIdleWsSessionState(now = Date.now()): void {
		for (const [sessionKey, disabledUntil] of this.wsDisabledUntilBySessionKey) {
			if (disabledUntil <= now) {
				this.wsDisabledUntilBySessionKey.delete(sessionKey);
			}
		}
		for (const [sessionKey, state] of this.wsStateBySessionKey) {
			if (
				typeof state.lastUsedAt === "number" &&
				now - state.lastUsedAt <= WS_SESSION_IDLE_TTL_MS
			) {
				continue;
			}
			this.closeWsSafely(state.ws, "idle_evict");
			this.wsStateBySessionKey.delete(sessionKey);
		}
	}

	private isWsSessionDisabled(sessionKey: string, now = Date.now()): boolean {
		const disabledUntil = this.wsDisabledUntilBySessionKey.get(sessionKey);
		if (disabledUntil === undefined) {
			return false;
		}
		if (disabledUntil <= now) {
			this.wsDisabledUntilBySessionKey.delete(sessionKey);
			return false;
		}
		return true;
	}

	private getIncrementalInput(
		previousInput: ResponseInput | string | undefined,
		currentInput: ResponseInput | string | undefined,
	): ResponseInput | undefined | null {
		if (previousInput === undefined) {
			return undefined;
		}
		if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) {
			return safeJsonStringify(previousInput) === safeJsonStringify(currentInput)
				? ([] as ResponseInput)
				: null;
		}
		if (previousInput.length > currentInput.length) {
			return null;
		}
		for (let index = 0; index < previousInput.length; index += 1) {
			if (
				safeJsonStringify(previousInput[index]) !==
				safeJsonStringify(currentInput[index])
			) {
				return null;
			}
		}
		if (previousInput.length === currentInput.length) {
			return [] as ResponseInput;
		}
		return currentInput.slice(previousInput.length);
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
		transport: "http_stream" | "ws_mode" = "http_stream",
		fallbackUsed = false,
		chainReset?: boolean,
		wsInputMode?: OpenAiWsInputMode,
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
		const instructionsHash = createHash("sha256")
			.update(String(request.instructions ?? ""))
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
			const sessionHeaderSuffix = sessionIdHeader
				? ` session_id_header=on session_id_hash=${createHash("sha256")
						.update(sessionIdHeader)
						.digest("hex")
						.slice(0, 12)}`
				: " session_id_header=off";
			const chainResetSuffix =
				typeof chainReset === "boolean"
					? ` chain_reset=${chainReset ? "true" : "false"}`
					: "";
			const wsInputModeSuffix = wsInputMode
				? ` ws_input_mode=${wsInputMode}`
				: "";
			console.error(
				`[openai.request] seq=${seq} transport=${transport} websocket_mode=${this.websocketMode} fallback_used=${fallbackUsed ? "true" : "false"} bytes=${payload.length} sha256_16=${hash} shared_prefix=${shared} shared_ratio=${sharedRatio}% tools_sha=${toolsHash} instructions_sha=${instructionsHash}${chainResetSuffix}${wsInputModeSuffix}${sessionHeaderSuffix}`,
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
		transport: "http_stream" | "ws_mode",
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
				`[openai.response] seq=${seq} transport=${transport} websocket_mode=${this.websocketMode} id=${response.id} status=${response.status} items=${outputItems.length} kinds=${Array.from(outputKinds).join(",")} tok_in=${usageIn} cached_in=${cachedInputTokens}`,
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
