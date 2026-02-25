import type {
	Response,
	ResponseCreateParamsBase,
	ResponseInput,
	ResponsesClientEvent,
} from "openai/resources/responses/responses";

export type OpenAiTransport = "http_stream" | "ws_mode";

export type OpenAiWebsocketMode = "off" | "auto" | "on";
export type OpenAiWebsocketApiVersion = "v1" | "v2";
export type OpenAiWsInputMode =
	| "full_no_previous"
	| "full_regenerated"
	| "incremental"
	| "empty";

export type OpenAiTransportMeta = {
	transport?: OpenAiTransport;
	websocket_mode?: OpenAiWebsocketMode;
	fallback_used?: boolean;
	chain_reset?: boolean;
	ws_reconnect_count?: number;
	ws_input_mode?: OpenAiWsInputMode;
};

export type OpenAiResponsesWsLike = {
	on(event: string, listener: (event: unknown) => void): OpenAiResponsesWsLike;
	off?: (event: string, listener: (event: unknown) => void) => OpenAiResponsesWsLike;
	send(event: ResponsesClientEvent): void;
	close(props?: { code: number; reason: string }): void;
};

export type OpenAiNativeWsSocketLike = {
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

export type OpenAiUnexpectedResponseLike = {
	statusCode?: number;
	headers?: Record<string, unknown>;
	on?: (event: string, listener: (...args: unknown[]) => void) => void;
	off?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type WsConversationState = {
	previousResponseId?: string;
	instructionsHash?: string;
	toolsHash?: string;
	model?: string;
	lastInput?: ResponseInput | string;
	ws?: OpenAiResponsesWsLike;
	lastUsedAt?: number;
};

export type OpenAiTransportInvokeResult = {
	response: Response;
	transport: OpenAiTransport;
	fallbackUsed: boolean;
	chainReset: boolean;
	wsInputMode?: OpenAiWsInputMode;
};

export type OpenAiRequestMeta = {
	model: string;
	instructionsHash: string;
	toolsHash: string;
};

export type OpenAiWsExecutionPlan = {
	request: ResponseCreateParamsBase;
	chainReset: boolean;
	wsInputMode: OpenAiWsInputMode;
	requiresWsConnectionReset: boolean;
	hasReusableWs: boolean;
};
