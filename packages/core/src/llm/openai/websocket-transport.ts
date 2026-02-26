import type OpenAI from "openai";
import type {
	Response,
	ResponseCompletedEvent,
	ResponseCreateParamsBase,
	ResponsesClientEvent,
} from "openai/resources/responses/responses";
import { ResponsesWS } from "openai/resources/responses/ws";
import type {
	OpenAiNativeWsSocketLike,
	OpenAiResponsesWsLike,
	OpenAiUnexpectedResponseLike,
	OpenAiWebsocketApiVersion,
} from "./transport-types";

const WS_CONNECT_TIMEOUT_MS = 30_000;
const WS_RESPONSE_IDLE_TIMEOUT_MS = 300_000;
const WS_UNEXPECTED_RESPONSE_BODY_TIMEOUT_MS = 250;
const WS_UNEXPECTED_RESPONSE_BODY_MAX_CHARS = 2_000;
const OPENAI_BETA_HEADER = "OpenAI-Beta";
const OPENAI_BETA_RESPONSES_WEBSOCKETS_V1 = "responses_websockets=2026-02-04";
const OPENAI_BETA_RESPONSES_WEBSOCKETS_V2 = "responses_websockets=2026-02-06";

type OpenAiWsTransportOptions = {
	client: OpenAI;
	websocketApiVersion: OpenAiWebsocketApiVersion;
	createResponsesWs?: (
		client: OpenAI,
		options?: ConstructorParameters<typeof ResponsesWS>[1],
	) => OpenAiResponsesWsLike;
	wsConnectTimeoutMs?: number;
	wsResponseIdleTimeoutMs?: number;
};

const resolveTimeoutMs = (
	value: number | undefined,
	fallbackMs: number,
): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallbackMs;
	}
	return Math.floor(value);
};

class WsResponseError extends Error {
	constructor(
		message: string,
		readonly code?: string,
	) {
		super(message);
	}
}

export class OpenAiWsTransport {
	private readonly client: OpenAI;
	private readonly websocketApiVersion: OpenAiWebsocketApiVersion;
	private readonly createResponsesWs?: OpenAiWsTransportOptions["createResponsesWs"];
	private readonly wsConnectTimeoutMs: number;
	private readonly wsResponseIdleTimeoutMs: number;

	constructor(options: OpenAiWsTransportOptions) {
		this.client = options.client;
		this.websocketApiVersion = options.websocketApiVersion;
		this.createResponsesWs = options.createResponsesWs;
		this.wsConnectTimeoutMs = resolveTimeoutMs(
			options.wsConnectTimeoutMs,
			WS_CONNECT_TIMEOUT_MS,
		);
		this.wsResponseIdleTimeoutMs = resolveTimeoutMs(
			options.wsResponseIdleTimeoutMs,
			WS_RESPONSE_IDLE_TIMEOUT_MS,
		);
	}

	async invoke(args: {
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
		const wsOptions = { headers: wsOptionsHeaders };
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
			let rejectResponsePromise: ((error: unknown) => void) | undefined;
			const closeWs = (): void => {
				this.closeWithoutMaskingPrimaryError(ws, "done");
			};
			const responsePromise = new Promise<Response>((resolve, reject) => {
				let onAbort: (() => void) | undefined;
				const nativeSocket = this.getNativeSocket(ws);
				let removeNativeClose: (() => void) | undefined;
				let removeNativeError: (() => void) | undefined;
				let removeNativeMessage: (() => void) | undefined;
				let timeout: NodeJS.Timeout | undefined;
				const resetResponseTimeout = (): void => {
					if (settled) return;
					if (timeout) {
						clearTimeout(timeout);
					}
					timeout = setTimeout(() => {
						if (settled) return;
						settled = true;
						teardown();
						reject(new Error("openai websocket response timeout"));
					}, this.wsResponseIdleTimeoutMs);
				};
				const teardown = (): void => {
					if (ws.off) {
						ws.off("error", onError);
						ws.off("event", onEvent);
						ws.off("response.failed", onResponseFailed);
						ws.off("response.completed", onResponseCompleted);
						ws.off("close", onClose);
					}
					if (timeout) {
						clearTimeout(timeout);
					}
					removeNativeClose?.();
					removeNativeError?.();
					removeNativeMessage?.();
					if (args.signal && onAbort) {
						args.signal.removeEventListener("abort", onAbort);
					}
				};
				const resolveOnce = (response: Response): void => {
					if (settled) return;
					settled = true;
					teardown();
					resolve(response);
				};
				const rejectOnce = (error: unknown): void => {
					if (settled) return;
					settled = true;
					teardown();
					reject(error);
				};
				rejectResponsePromise = rejectOnce;
				const onError = (error: unknown): void => {
					rejectOnce(error);
				};
				const onEvent = (): void => {
					resetResponseTimeout();
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
				ws.on("event", onEvent);
				ws.on("response.failed", onResponseFailed);
				ws.on("response.completed", onResponseCompleted);
				ws.on("close", onClose);
				// OpenAI ResponsesWS does not currently re-emit native socket "close",
				// so we watch the underlying socket directly to detect idle/LB disconnects.
				removeNativeClose = this.addNativeSocketListener(
					nativeSocket,
					"close",
					(...events: unknown[]) => {
						onClose(events[0]);
					},
				);
				removeNativeError = this.addNativeSocketListener(
					nativeSocket,
					"error",
					(error: unknown) => {
						onError(error);
					},
				);
				removeNativeMessage = this.addNativeSocketListener(
					nativeSocket,
					"message",
					() => {
						resetResponseTimeout();
					},
				);
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
				resetResponseTimeout();
			});
			const responseCreateEvent = {
				type: "response.create",
				...args.request,
			} as ResponsesClientEvent;
			if (!settled) {
				try {
					ws.send(responseCreateEvent);
				} catch (error) {
					rejectResponsePromise?.(error);
				}
			}
			const response = await responsePromise;
			return { response, ws };
		} catch (error) {
			if (ownsWs) {
				this.closeWithoutMaskingPrimaryError(ws, "failed", error);
			}
			throw error;
		}
	}

	closeSafely(ws: OpenAiResponsesWsLike | undefined, reason: string): void {
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

	closeWithoutMaskingPrimaryError(
		ws: OpenAiResponsesWsLike | undefined,
		reason: string,
		primaryError?: unknown,
	): void {
		try {
			this.closeSafely(ws, reason);
		} catch (closeError) {
			const suffix = primaryError
				? ` primary_error=${String(primaryError)}`
				: "";
			console.error(
				`[openai.ws] close_unexpected_failure reason=${reason} error=${String(closeError)}${suffix}`,
			);
		}
	}

	isConnectionReusable(ws: OpenAiResponsesWsLike | undefined): boolean {
		if (!ws) {
			return false;
		}
		const socket = this.getNativeSocket(ws);
		if (!socket) {
			return true;
		}
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

	extractErrorCode(error: unknown): string | undefined {
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

	private getNativeSocket(
		ws: OpenAiResponsesWsLike,
	): OpenAiNativeWsSocketLike | undefined {
		const maybeSocket = (ws as { socket?: unknown }).socket;
		if (!maybeSocket || typeof maybeSocket !== "object") {
			return undefined;
		}
		return maybeSocket as OpenAiNativeWsSocketLike;
	}

	private addNativeSocketListener(
		socket: OpenAiNativeWsSocketLike | undefined,
		event: string,
		listener: (...args: unknown[]) => void,
	): (() => void) | undefined {
		if (!socket) {
			return undefined;
		}
		if (typeof socket.on === "function") {
			socket.on(event, listener);
			return () => {
				if (typeof socket.off === "function") {
					socket.off(event, listener);
				}
			};
		}
		if (typeof socket.addEventListener === "function") {
			socket.addEventListener(event, listener);
			return () => {
				if (typeof socket.removeEventListener === "function") {
					socket.removeEventListener(event, listener);
				}
			};
		}
		return undefined;
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
			}, this.wsConnectTimeoutMs);
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
}
