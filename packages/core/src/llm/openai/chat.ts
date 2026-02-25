import { createHash } from "node:crypto";
import OpenAI, { type ClientOptions } from "openai";
import type {
	Response,
	ResponseCompletedEvent,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseTextConfig,
	ResponsesClientEvent,
} from "openai/resources/responses/responses";
import { ResponsesWS } from "openai/resources/responses/ws";
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

const WS_RESPONSE_TIMEOUT_MS = 45_000;
const WS_UNEXPECTED_RESPONSE_BODY_TIMEOUT_MS = 250;
const WS_UNEXPECTED_RESPONSE_BODY_MAX_CHARS = 2_000;
const WS_SESSION_IDLE_TTL_MS = 10 * 60_000;
const WS_SESSION_DISABLE_TTL_MS = 60_000;
const OPENAI_BETA_HEADER = "OpenAI-Beta";
const OPENAI_BETA_RESPONSES_WEBSOCKETS_V1 = "responses_websockets=2026-02-04";
const OPENAI_BETA_RESPONSES_WEBSOCKETS_V2 = "responses_websockets=2026-02-06";

class WsResponseError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

type WsConversationState = {
	previousResponseId?: string;
	instructionsHash?: string;
	toolsHash?: string;
	model?: string;
	lastInput?: ResponseInput | string;
	ws?: OpenAiResponsesWsLike;
	lastUsedAt?: number;
};

type TransportInvokeResult = {
	response: Response;
	transport: "http_stream" | "ws_mode";
	fallbackUsed: boolean;
	chainReset: boolean;
	wsInputMode?: "full_no_previous" | "full_regenerated" | "incremental" | "empty";
};

export type OpenAiWebsocketMode = "off" | "auto" | "on";
export type OpenAiWebsocketApiVersion = "v1" | "v2";

type OpenAiResponsesWsLike = {
	on(event: string, listener: (event: unknown) => void): OpenAiResponsesWsLike;
	off?: (event: string, listener: (event: unknown) => void) => OpenAiResponsesWsLike;
	send(event: ResponsesClientEvent): void;
	close(props?: { code: number; reason: string }): void;
};

type OpenAiNativeWsSocketLike = {
	readyState?: number;
	OPEN?: number;
	CONNECTING?: number;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
	off?: (event: string, listener: (...args: unknown[]) => void) => void;
	addEventListener?: (
		event: string,
		listener: (...args: unknown[]) => void,
	) => void;
	removeEventListener?: (
		event: string,
		listener: (...args: unknown[]) => void,
	) => void;
};

type OpenAiUnexpectedResponseLike = {
	statusCode?: number;
	headers?: Record<string, unknown>;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
	off?: (event: string, listener: (...args: unknown[]) => void) => void;
};

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
	private readonly createResponsesWs: ChatOpenAIOptions["createResponsesWs"];
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
		this.createResponsesWs = options.createResponsesWs;
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
		requestMeta: {
			model: string;
			instructionsHash: string;
			toolsHash: string;
		};
	}): Promise<TransportInvokeResult> {
		this.evictIdleWsSessionState();
		if (this.websocketMode === "off") {
			await this.debugRequestIfEnabled(
				args.request,
				args.debugSeq,
				args.sessionIdHeader,
				"http_stream",
				false,
				false,
			);
			const response = await this.invokeViaHttp(
				args.request,
				args.signal,
				args.sessionIdHeader,
			);
			return {
				response,
				transport: "http_stream",
				fallbackUsed: false,
				chainReset: false,
			};
		}
		if (!args.sessionKey) {
			if (this.websocketMode === "on") {
				throw new Error(
					"openai websocket_mode=on requires a session key for stable chaining",
				);
			}
			await this.debugRequestIfEnabled(
				args.request,
				args.debugSeq,
				args.sessionIdHeader,
				"http_stream",
				false,
				false,
			);
			const response = await this.invokeViaHttp(
				args.request,
				args.signal,
				args.sessionIdHeader,
			);
			return {
				response,
				transport: "http_stream",
				fallbackUsed: false,
				chainReset: false,
			};
		}
		if (this.isWsSessionDisabled(args.sessionKey)) {
			await this.debugRequestIfEnabled(
				args.request,
				args.debugSeq,
				args.sessionIdHeader,
				"http_stream",
				true,
				true,
			);
			const response = await this.invokeViaHttp(
				args.request,
				args.signal,
				args.sessionIdHeader,
			);
			return {
				response,
				transport: "http_stream",
				fallbackUsed: true,
				chainReset: true,
			};
		}
		const wsState = this.wsStateBySessionKey.get(args.sessionKey) ?? {};
		const hasReusableWs = this.isWsConnectionReusable(wsState.ws);
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
		let wsInputMode: TransportInvokeResult["wsInputMode"] = "full_no_previous";
		if (Boolean(wsState.previousResponseId)) {
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
		const wsRequest: ResponseCreateParamsBase = {
			...args.request,
			...(canUsePreviousResponseId
				? { previous_response_id: wsState.previousResponseId }
				: {}),
			...(canUsePreviousResponseId && incrementalInput !== undefined
				? { input: incrementalInput }
				: {}),
		};
		const requiresWsConnectionReset =
			Boolean(wsState.ws) &&
			(!hasReusableWs ||
				(Boolean(wsState.previousResponseId) && !canUsePreviousResponseId));
		try {
			if (requiresWsConnectionReset) {
				this.closeWsSafely(
					wsState.ws,
					hasReusableWs ? "chain_reset" : "stale_connection",
				);
			}
			await this.debugRequestIfEnabled(
				wsRequest,
				args.debugSeq,
				args.sessionIdHeader,
				"ws_mode",
				false,
				chainReset,
				wsInputMode,
			);
			const { response, ws } = await this.invokeViaWs({
				request: wsRequest,
				signal: args.signal,
				sessionIdHeader: args.sessionIdHeader,
				ws:
					requiresWsConnectionReset || !hasReusableWs ? undefined : wsState.ws,
			});
			this.wsDisabledUntilBySessionKey.delete(args.sessionKey);
			this.wsStateBySessionKey.set(args.sessionKey, {
				previousResponseId: response.id,
				instructionsHash: args.requestMeta.instructionsHash,
				toolsHash: args.requestMeta.toolsHash,
				model: args.requestMeta.model,
				lastInput: args.request.input,
				ws,
				lastUsedAt: Date.now(),
			});
			return {
				response,
				transport: "ws_mode",
				fallbackUsed: false,
				chainReset,
				wsInputMode,
			};
		} catch (error) {
			const wsErrorCode = this.extractWsErrorCode(error);
			const wsErrorMessage =
				error instanceof Error ? error.message.toLowerCase() : "";
			const shouldDisableWsForSession =
				wsErrorCode === "previous_response_not_found" ||
				wsErrorMessage.includes("previous_response_not_found") ||
				wsErrorMessage.includes("could not send data") ||
				wsErrorMessage.includes("unexpected server response");
			this.clearWsSessionState(args.sessionKey, "reset", error);
			if (shouldDisableWsForSession) {
				this.wsDisabledUntilBySessionKey.set(
					args.sessionKey,
					Date.now() + WS_SESSION_DISABLE_TTL_MS,
				);
			}
			if (!fallbackAllowed) {
				throw error;
			}
			this.wsReconnectCount += 1;
			await this.debugRequestIfEnabled(
				args.request,
				args.debugSeq,
				args.sessionIdHeader,
				"http_stream",
				true,
				true,
				wsInputMode,
			);
			const response = await this.invokeViaHttp(
				args.request,
				args.signal,
				args.sessionIdHeader,
			);
			return {
				response,
				transport: "http_stream",
				fallbackUsed: true,
				chainReset: true,
			};
		}
	}

	private async invokeViaHttp(
		request: ResponseCreateParamsBase,
		signal?: AbortSignal,
		sessionIdHeader?: string,
	): Promise<Response> {
		const streamRequest: ResponseCreateParamsStreaming = {
			...request,
			stream: true,
		};
		return this.client.responses
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
	}

	private async invokeViaWs(args: {
		request: ResponseCreateParamsBase;
		signal?: AbortSignal;
		sessionIdHeader?: string;
		ws?: OpenAiResponsesWsLike;
	}): Promise<{ response: Response; ws: OpenAiResponsesWsLike }> {
		await this.prepareClientForWsHandshake();
		const wsOptionsHeaders: Record<string, string> = {
			...this.getClientDefaultHeaders(),
			[OPENAI_BETA_HEADER]:
				this.websocketApiVersion === "v2"
					? OPENAI_BETA_RESPONSES_WEBSOCKETS_V2
					: OPENAI_BETA_RESPONSES_WEBSOCKETS_V1,
		};
		if (args.sessionIdHeader) {
			wsOptionsHeaders.session_id = args.sessionIdHeader;
		}
		const wsOptions = {
			headers: wsOptionsHeaders,
		};
		const ownsWs = !args.ws;
		const ws =
			args.ws ??
			((this.createResponsesWs
				? this.createResponsesWs(this.client, wsOptions)
				: (new ResponsesWS(
						this.client as never,
						wsOptions,
					) as unknown as OpenAiResponsesWsLike)) as OpenAiResponsesWsLike);
		if (!args.ws) {
			// Keep a permanent error listener to avoid unhandled SDK websocket errors
			// that can arrive after per-request listeners are detached.
			ws.on("error", () => {});
		}
		try {
			await this.waitForWsOpen(ws, args.signal);
			let settled = false;
			const closeWs = (): void => {
				this.closeWsWithoutMaskingPrimaryError(ws, "done");
			};
			const responsePromise = new Promise<Response>((resolve, reject) => {
				let onAbort: (() => void) | undefined;
				const timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					teardown();
					reject(new Error("openai websocket response timeout"));
				}, WS_RESPONSE_TIMEOUT_MS);
				const teardown = (): void => {
					if (ws.off) {
						ws.off("error", onError);
						ws.off("response.failed", onResponseFailed);
						ws.off("response.completed", onResponseCompleted);
						ws.off("close", onClose);
					}
					if (args.signal && onAbort) {
						args.signal.removeEventListener("abort", onAbort);
					}
				};
				const resolveOnce = (response: Response): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					teardown();
					resolve(response);
				};
				const rejectOnce = (error: unknown): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					teardown();
					reject(error);
				};
				const onError = (error: unknown): void => {
					rejectOnce(error);
				};
				const onResponseFailed = (event: unknown): void => {
					const failed = event as {
						response?: {
							error?: { message?: string | null; code?: string | null } | null;
						};
					};
					const message = failed.response?.error?.message;
					const code = failed.response?.error?.code ?? undefined;
					rejectOnce(
						new WsResponseError(
							message || "openai websocket response failed",
							typeof code === "string" ? code : undefined,
						),
					);
				};
				const onResponseCompleted = (event: unknown): void => {
					const completed = event as ResponseCompletedEvent;
					resolveOnce(completed.response);
				};
				const onClose = (event: unknown): void => {
					const closeCode = this.extractWsCloseCode(event);
					rejectOnce(
						new Error(
							`openai websocket closed before response${closeCode ? ` code=${closeCode}` : ""}`,
						),
					);
				};
				ws.on("error", onError);
				ws.on("response.failed", onResponseFailed);
				ws.on("response.completed", onResponseCompleted);
				ws.on("close", onClose);
				if (args.signal) {
					onAbort = () => {
						rejectOnce(new Error("openai websocket request aborted"));
						closeWs();
					};
					args.signal.addEventListener("abort", onAbort, { once: true });
					if (args.signal.aborted) {
						onAbort();
					}
				}
			});
			const responseCreateEvent = {
				type: "response.create",
				...args.request,
			} as ResponsesClientEvent;
			if (!settled) {
				ws.send(responseCreateEvent);
			}
			const response = await responsePromise;
			return { response, ws };
		} catch (error) {
			if (ownsWs) {
				this.closeWsWithoutMaskingPrimaryError(ws, "failed", error);
			}
			throw error;
		}
	}

	private async prepareClientForWsHandshake(): Promise<void> {
		const maybeClient = this.client as unknown as {
			prepareOptions?: (options: unknown) => Promise<void> | void;
		};
		if (typeof maybeClient.prepareOptions !== "function") {
			return;
		}
		await maybeClient.prepareOptions({});
	}

	private getClientDefaultHeaders(): Record<string, string> {
		const headers: Record<string, string> = {};
		const source = (this.client as unknown as {
			_options?: { defaultHeaders?: unknown };
		})._options?.defaultHeaders;
		if (!source) {
			return headers;
		}
		const addHeader = (key: string, value: unknown): void => {
			if (!key) return;
			if (value === undefined || value === null) return;
			headers[key] = String(value);
		};
		if (source instanceof Headers) {
			for (const [key, value] of source.entries()) {
				addHeader(key, value);
			}
			return headers;
		}
		if (Array.isArray(source)) {
			for (const item of source) {
				if (!Array.isArray(item) || item.length < 2) continue;
				addHeader(String(item[0]), item[1]);
			}
			return headers;
		}
		if (typeof source === "object") {
			for (const [key, value] of Object.entries(source)) {
				addHeader(key, value);
			}
		}
		return headers;
	}

	private extractWsCloseCode(event: unknown): number | undefined {
		if (typeof event === "number") {
			return event;
		}
		if (!event || typeof event !== "object") {
			return undefined;
		}
		const maybeEvent = event as { code?: unknown };
		return typeof maybeEvent.code === "number" ? maybeEvent.code : undefined;
	}

	private closeWsSafely(
		ws: OpenAiResponsesWsLike | undefined,
		reason: string,
	): void {
		if (!ws) {
			return;
		}
		try {
			ws.close({ code: 1000, reason });
		} catch (error) {
			if (this.isExpectedWsCloseError(error)) {
				console.error(
					`[openai.ws] close_expected_failure reason=${reason} error=${String(error)}`,
				);
				return;
			}
			throw error instanceof Error ? error : new Error(String(error));
		}
	}

	private closeWsWithoutMaskingPrimaryError(
		ws: OpenAiResponsesWsLike | undefined,
		reason: string,
		primaryError?: unknown,
	): void {
		try {
			this.closeWsSafely(ws, reason);
		} catch (closeError) {
			const suffix = primaryError
				? ` primary_error=${String(primaryError)}`
				: "";
			console.error(
				`[openai.ws] close_unexpected_failure reason=${reason} error=${String(closeError)}${suffix}`,
			);
		}
	}

	private isExpectedWsCloseError(error: unknown): boolean {
		if (!error || typeof error !== "object") {
			return false;
		}
		const maybeError = error as { code?: unknown; message?: unknown };
		if (typeof maybeError.code === "string") {
			if (
				maybeError.code === "ERR_SOCKET_CLOSED" ||
				maybeError.code === "ERR_INVALID_STATE"
			) {
				return true;
			}
		}
		if (typeof maybeError.message !== "string") {
			return false;
		}
		const message = maybeError.message.toLowerCase();
		return (
			message.includes("not open") ||
			message.includes("already closed") ||
			message.includes("was closed before") ||
			message.includes("readystate") ||
			message.includes("closing") ||
			message.includes("closed")
		);
	}

	private isWsConnectionReusable(ws: OpenAiResponsesWsLike | undefined): boolean {
		if (!ws) {
			return false;
		}
		const maybeSocket = (ws as { socket?: unknown }).socket;
		if (!maybeSocket || typeof maybeSocket !== "object") {
			return true;
		}
		const socket = maybeSocket as OpenAiNativeWsSocketLike;
		if (typeof socket.readyState !== "number") {
			return true;
		}
		const openState = typeof socket.OPEN === "number" ? socket.OPEN : 1;
		const connectingState =
			typeof socket.CONNECTING === "number" ? socket.CONNECTING : 0;
		return (
			socket.readyState === openState || socket.readyState === connectingState
		);
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

	private extractWsErrorCode(error: unknown): string | undefined {
		if (error instanceof WsResponseError && typeof error.code === "string") {
			return error.code;
		}
		if (!error || typeof error !== "object") {
			return undefined;
		}
		const maybeError = error as {
			code?: unknown;
			error?: {
				code?: unknown;
				error?: {
					code?: unknown;
				};
			};
		};
		if (typeof maybeError.code === "string") {
			return maybeError.code;
		}
		if (typeof maybeError.error?.code === "string") {
			return maybeError.error.code;
		}
		if (typeof maybeError.error?.error?.code === "string") {
			return maybeError.error.error.code;
		}
		return undefined;
	}

	private formatUnexpectedResponseHeaders(
		headers: OpenAiUnexpectedResponseLike["headers"],
	): string | undefined {
		if (!headers || typeof headers !== "object") {
			return undefined;
		}
		const entries = Object.entries(headers);
		if (entries.length === 0) {
			return undefined;
		}
		const limited = entries.slice(0, 12).map(([key, value]) => {
			const text = Array.isArray(value)
				? value.map((entry) => String(entry)).join("|")
				: String(value);
			return `${key}:${text}`;
		});
		return limited.join(", ");
	}

	private toUnexpectedResponseChunkText(chunk: unknown): string {
		if (typeof chunk === "string") {
			return chunk;
		}
		if (chunk instanceof Uint8Array) {
			return Buffer.from(chunk).toString("utf8");
		}
		if (chunk instanceof ArrayBuffer) {
			return Buffer.from(chunk).toString("utf8");
		}
		if (ArrayBuffer.isView(chunk)) {
			return Buffer.from(
				chunk.buffer,
				chunk.byteOffset,
				chunk.byteLength,
			).toString("utf8");
		}
		return "";
	}

	private async readUnexpectedResponseBody(
		response: OpenAiUnexpectedResponseLike,
	): Promise<string | undefined> {
		if (typeof response.on !== "function") {
			return undefined;
		}
		return new Promise((resolve) => {
			let body = "";
			let settled = false;
			const listeners: Array<{
				event: string;
				listener: (...args: unknown[]) => void;
			}> = [];
			const removeListeners = (): void => {
				if (typeof response.off !== "function") {
					return;
				}
				for (const entry of listeners) {
					response.off(entry.event, entry.listener);
				}
			};
			const settle = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				removeListeners();
				const normalized = body.trim();
				resolve(normalized.length > 0 ? normalized : undefined);
			};
			const addListener = (
				event: string,
				listener: (...args: unknown[]) => void,
			): void => {
				response.on?.(event, listener);
				listeners.push({ event, listener });
			};
			const timeout = setTimeout(() => {
				settle();
			}, WS_UNEXPECTED_RESPONSE_BODY_TIMEOUT_MS);
			addListener("data", (chunk: unknown) => {
				if (body.length >= WS_UNEXPECTED_RESPONSE_BODY_MAX_CHARS) {
					return;
				}
				const text = this.toUnexpectedResponseChunkText(chunk);
				if (!text) {
					return;
				}
				const remaining = WS_UNEXPECTED_RESPONSE_BODY_MAX_CHARS - body.length;
				body += text.slice(0, remaining);
			});
			addListener("end", () => {
				settle();
			});
			addListener("error", () => {
				settle();
			});
		});
	}

	private async createUnexpectedResponseError(
		responseLike: unknown,
	): Promise<Error> {
		const response =
			responseLike && typeof responseLike === "object"
				? (responseLike as OpenAiUnexpectedResponseLike)
				: undefined;
		if (!response) {
			return new Error("unexpected server response");
		}
		const status =
			typeof response.statusCode === "number" ? response.statusCode : undefined;
		const headers = this.formatUnexpectedResponseHeaders(response.headers);
		const body = await this.readUnexpectedResponseBody(response);
		const detailParts: string[] = [];
		if (headers) {
			detailParts.push(`headers=${headers}`);
		}
		if (body) {
			detailParts.push(`body=${body}`);
		}
		const suffix = detailParts.length > 0 ? ` (${detailParts.join(" ")})` : "";
		return new Error(
			`unexpected server response${status ? `: ${status}` : ""}${suffix}`,
		);
	}

	private async waitForWsOpen(
		ws: OpenAiResponsesWsLike,
		signal?: AbortSignal,
	): Promise<void> {
		const maybeSocket = (ws as { socket?: unknown }).socket;
		if (!maybeSocket || typeof maybeSocket !== "object") {
			return;
		}
		const socket = maybeSocket as OpenAiNativeWsSocketLike;
		const openState = typeof socket.OPEN === "number" ? socket.OPEN : 1;
		const connectingState =
			typeof socket.CONNECTING === "number" ? socket.CONNECTING : 0;
		if (socket.readyState === openState) {
			return;
		}
		if (socket.readyState !== connectingState) {
			throw new Error(
				`openai websocket is not open (readyState=${String(socket.readyState ?? "unknown")})`,
			);
		}
		if (signal?.aborted) {
			throw new Error("openai websocket aborted before open");
		}
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const removeFns: Array<() => void> = [];
			const teardown = (): void => {
				for (const remove of removeFns) {
					remove();
				}
			};
			const settleResolve = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				teardown();
				resolve();
			};
			const settleReject = (error: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				teardown();
				reject(error);
			};
			const addSocketListener = (
				event: string,
				listener: (...args: unknown[]) => void,
			): void => {
				if (typeof socket.on === "function") {
					socket.on(event, listener);
					removeFns.push(() => {
						if (typeof socket.off === "function") {
							socket.off(event, listener);
						}
					});
					return;
				}
				if (typeof socket.addEventListener === "function") {
					socket.addEventListener(event, listener);
					removeFns.push(() => {
						if (typeof socket.removeEventListener === "function") {
							socket.removeEventListener(event, listener);
						}
					});
				}
			};
			const timeout = setTimeout(() => {
				settleReject(new Error("openai websocket connect timeout"));
			}, WS_RESPONSE_TIMEOUT_MS);
			addSocketListener("open", () => {
				settleResolve();
			});
			addSocketListener("error", (error: unknown) => {
				settleReject(error);
			});
			addSocketListener(
				"unexpected-response",
				(...args: unknown[]) => {
					void this.createUnexpectedResponseError(args[1])
						.then((error) => {
							settleReject(error);
						})
						.catch((error) => {
							settleReject(error);
						});
				},
			);
			addSocketListener("close", (code: unknown) => {
				const closeCode = typeof code === "number" ? ` code=${code}` : "";
				settleReject(
					new Error(`openai websocket closed before open${closeCode}`),
				);
			});
			if (signal) {
				const onAbort = (): void => {
					settleReject(new Error("openai websocket aborted before open"));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				removeFns.push(() => {
					signal.removeEventListener("abort", onAbort);
				});
			}
			if (socket.readyState === openState) {
				settleResolve();
			}
		});
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
		wsInputMode?: "full_no_previous" | "full_regenerated" | "incremental" | "empty",
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
