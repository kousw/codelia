import { describe, expect, test } from "bun:test";
import type {
	Response,
	ResponseCreateParamsStreaming,
	ResponsesClientEvent,
} from "openai/resources/responses/responses";
import { ChatOpenAI } from "../src/llm/openai/chat";

type StreamCall = {
	request: ResponseCreateParamsStreaming;
	options?: { headers?: Record<string, string>; signal?: AbortSignal };
};

class MockResponsesSocket {
	private listeners = new Map<string, Array<(event: unknown) => void>>();
	public sent: ResponsesClientEvent[] = [];
	public closeCount = 0;

	on(event: string, listener: (event: unknown) => void): this {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
		return this;
	}

	off(event: string, listener: (event: unknown) => void): this {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			list.filter((entry) => entry !== listener),
		);
		return this;
	}

	send(event: ResponsesClientEvent): void {
		this.sent.push(event);
		setTimeout(() => {
			this.emit("response.completed", {
				type: "response.completed",
				sequence_number: 1,
				response: buildWsResponse(),
			});
		}, 0);
	}

	close(): void {
		this.closeCount += 1;
	}

	emit(event: string, payload: unknown): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(payload);
		}
	}
}

class MockNativeSocket {
	readonly CONNECTING = 0;
	readonly OPEN = 1;
	readyState = this.CONNECTING;
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	on(event: string, listener: (...args: unknown[]) => void): void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
	}

	off(event: string, listener: (...args: unknown[]) => void): void {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			list.filter((entry) => entry !== listener),
		);
	}

	open(): void {
		this.readyState = this.OPEN;
		this.emit("open");
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

class MockUnexpectedResponse {
	readonly statusCode: number;
	readonly headers: Record<string, string>;
	private listeners = new Map<string, Array<(...args: unknown[]) => void>>();

	constructor(statusCode: number, headers: Record<string, string>) {
		this.statusCode = statusCode;
		this.headers = headers;
	}

	on(event: string, listener: (...args: unknown[]) => void): void {
		const list = this.listeners.get(event) ?? [];
		list.push(listener);
		this.listeners.set(event, list);
	}

	off(event: string, listener: (...args: unknown[]) => void): void {
		const list = this.listeners.get(event) ?? [];
		this.listeners.set(
			event,
			list.filter((entry) => entry !== listener),
		);
	}

	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(...args);
		}
	}
}

class OpenAwareMockResponsesSocket extends MockResponsesSocket {
	readonly socket = new MockNativeSocket();
	sendBeforeOpen = 0;

	override send(event: ResponsesClientEvent): void {
		if (this.socket.readyState !== this.socket.OPEN) {
			this.sendBeforeOpen += 1;
			throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
		}
		super.send(event);
	}
}

class StatefulMockResponsesSocket extends MockResponsesSocket {
	readonly socket = new MockNativeSocket();

	constructor() {
		super();
		this.socket.open();
	}

	markClosed(code = 1006): void {
		this.socket.readyState = 3;
		this.emit("close", { code });
	}
}

class NativeCloseOnlyMockResponsesSocket extends MockResponsesSocket {
	readonly socket = new MockNativeSocket();

	constructor() {
		super();
		this.socket.open();
	}

	markNativeClosed(code = 1006): void {
		this.socket.readyState = 3;
		this.socket.emit("close", code);
	}
}

class ThrowingCloseMockResponsesSocket extends MockResponsesSocket {
	close(): void {
		throw new Error("catastrophic close failure");
	}
}

const buildHttpResponse = (): Response =>
	({
		id: "resp_http_1",
		created_at: 0,
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: "gpt-5",
		object: "response",
		status: "completed",
		output_text: "hello from http",
		output: [
			{
				type: "message",
				id: "msg_http_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "hello from http", annotations: [] }],
			},
		],
		parallel_tool_calls: false,
		temperature: 1,
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		truncation: "disabled",
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			input_tokens_details: {
				cached_tokens: 0,
			},
			output_tokens_details: {
				reasoning_tokens: 0,
			},
		},
		user: null,
	}) as unknown as Response;

const buildWsResponse = (id = "resp_ws_1"): Response =>
	({
		id,
		created_at: 0,
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: "gpt-5",
		object: "response",
		status: "completed",
		output_text: "hello from ws",
		output: [
			{
				type: "message",
				id: `msg_${id}`,
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "hello from ws", annotations: [] }],
			},
		],
		parallel_tool_calls: false,
		temperature: 1,
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		truncation: "disabled",
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			input_tokens_details: {
				cached_tokens: 2,
			},
			output_tokens_details: {
				reasoning_tokens: 0,
			},
		},
		user: null,
	}) as unknown as Response;

const createWsOnlyMockClient = () => ({
	responses: {
		stream: () => {
			throw new Error("http fallback should not be used");
		},
	},
});

const installWsCompletedResponder = (
	ws: StatefulMockResponsesSocket,
	responseId: string,
): void => {
	ws.send = (event: ResponsesClientEvent): void => {
		ws.sent.push(event);
		setTimeout(() => {
			ws.emit("response.completed", {
				type: "response.completed",
				sequence_number: 1,
				response: buildWsResponse(responseId),
			});
		}, 0);
	};
};

describe("ChatOpenAI websocket mode", () => {
	test("applies oauth default headers and resolves apiKey before websocket handshake", async () => {
		const clientState = { apiKey: "Missing Key" };
		const mockClient = {
			get apiKey() {
				return clientState.apiKey;
			},
			set apiKey(value: string) {
				clientState.apiKey = value;
			},
			_options: {
				defaultHeaders: {
					"ChatGPT-Account-ID": "org_test_123",
				},
			},
			prepareOptions: () => {
				clientState.apiKey = "token_ws_123";
			},
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new MockResponsesSocket();
		let observedWsHeaders: Record<string, string> | undefined;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: (_client, options) => {
				observedWsHeaders = options?.headers as Record<string, string> | undefined;
				return ws;
			},
		});

		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello oauth ws auth" }] },
			{ sessionKey: "session-oauth-ws-auth-1" },
		);

		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_1",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_no_previous",
		});
		expect(observedWsHeaders?.["ChatGPT-Account-ID"]).toBe("org_test_123");
		expect(observedWsHeaders?.["OpenAI-Beta"]).toBe(
			"responses_websockets=2026-02-06",
		);
		expect(clientState.apiKey).toBe("token_ws_123");
	});

	test("includes handshake response details when websocket unexpected-response occurs", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new OpenAwareMockResponsesSocket();
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				setTimeout(() => {
					const response = new MockUnexpectedResponse(500, {
						"x-request-id": "req_test_123",
						"content-type": "application/json",
					});
					ws.socket.emit("unexpected-response", {}, response);
					response.emit("data", '{"error":{"message":"oauth gateway failed"}}');
					response.emit("end");
				}, 0);
				return ws;
			},
		});

		let message = "";
		try {
			await chat.ainvoke(
				{ messages: [{ role: "user", content: "hello ws error details" }] },
				{ sessionKey: "session-unexpected-response-1" },
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("unexpected server response: 500");
		expect(message).toContain("x-request-id:req_test_123");
		expect(message).toContain("oauth gateway failed");
		expect(ws.sent.length).toBe(0);
	});

	test("waits for websocket open before sending response.create", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new OpenAwareMockResponsesSocket();
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => {
				setTimeout(() => {
					ws.socket.open();
				}, 0);
				return ws;
			},
		});

		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello open wait" }] },
			{ sessionKey: "session-open-wait-1" },
		);

		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_1",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_no_previous",
		});
		expect(ws.sendBeforeOpen).toBe(0);
		expect(ws.sent.length).toBe(1);
	});

	test("uses ws_mode when websocket_mode=auto and sessionKey exists", async () => {
		const calls: StreamCall[] = [];
		const mockClient = {
			responses: {
				stream: (
					request: ResponseCreateParamsStreaming,
					options?: StreamCall["options"],
				) => {
					calls.push({ request, options });
					return { finalResponse: async () => buildHttpResponse() };
				},
			},
		};
		const mockWs = new MockResponsesSocket();
		let observedWsHeaders: Record<string, string> | undefined;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: (_client, options) => {
				observedWsHeaders = options?.headers as Record<string, string> | undefined;
				return mockWs;
			},
		});
		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "say hello" }] },
			{ sessionKey: "session-ws-1" },
		);

		expect(calls).toHaveLength(0);
		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_1",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_no_previous",
		});
		expect(observedWsHeaders?.["OpenAI-Beta"]).toBe(
			"responses_websockets=2026-02-06",
		);
		expect(mockWs.sent.length).toBe(1);
	});

	test("forwards request options in websocket response.create", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new MockResponsesSocket();
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => ws,
		});

		await chat.ainvoke(
			{
				messages: [{ role: "user", content: "include ws fields" }],
				options: {
					max_output_tokens: 123,
					metadata: { trace_id: "trace_ws_1" },
					parallel_tool_calls: true,
				},
			},
			{ sessionKey: "session-forward-fields-1" },
		);

		const createEvent = ws.sent[0];
		if (!createEvent) {
			throw new Error("expected websocket request event");
		}
		expect(createEvent.type).toBe("response.create");
		expect(createEvent.max_output_tokens).toBe(123);
		expect(createEvent.parallel_tool_calls).toBe(true);
		expect(createEvent.metadata).toEqual({ trace_id: "trace_ws_1" });
	});

	test("rejects promptly when websocket request is aborted", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new MockResponsesSocket();
		ws.send = (event: ResponsesClientEvent): void => {
			ws.sent.push(event);
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => ws,
		});
		const controller = new AbortController();
		const startedAt = Date.now();
		const invokePromise = chat.ainvoke(
			{
				messages: [{ role: "user", content: "abort me" }],
				signal: controller.signal,
			},
			{ sessionKey: "session-abort-1" },
		);
		setTimeout(() => {
			controller.abort();
		}, 0);

		await expect(invokePromise).rejects.toThrow("openai websocket request aborted");
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(ws.closeCount).toBeGreaterThan(0);
	});

	test("reuses previous_response_id chain in websocket mode", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new MockResponsesSocket();
		let sendCount = 0;
		ws.send = (event: ResponsesClientEvent): void => {
			ws.sent.push(event);
			sendCount += 1;
			const responseId = sendCount === 1 ? "resp_ws_1" : "resp_ws_2";
			setTimeout(() => {
				ws.emit("response.completed", {
					type: "response.completed",
					sequence_number: 1,
					response: buildWsResponse(responseId),
				});
			}, 0);
		};
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => {
				createCount += 1;
				return ws;
			},
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-chain-1" },
		);
		const secondCompletion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-chain-1" },
		);

		expect(createCount).toBe(1);
		const firstCreate = ws.sent[0];
		if (!firstCreate) {
			throw new Error("expected first ws request");
		}
		expect(firstCreate.type).toBe("response.create");
		expect(firstCreate.previous_response_id).toBeUndefined();

		const secondCreate = ws.sent[1];
		if (!secondCreate) {
			throw new Error("expected second ws request");
		}
		expect(secondCreate.type).toBe("response.create");
		expect(secondCreate.previous_response_id).toBe("resp_ws_1");
		expect(secondCreate.input).toEqual([]);
		expect(ws.closeCount).toBe(0);
		expect(secondCompletion.provider_meta).toEqual({
			response_id: "resp_ws_2",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: false,
			ws_reconnect_count: 0,
			ws_input_mode: "empty",
		});
	});

	test("does not chain previous_response_id when input changes", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const ws = new MockResponsesSocket();
		let sendCount = 0;
		ws.send = (event: ResponsesClientEvent): void => {
			ws.sent.push(event);
			sendCount += 1;
			const responseId = sendCount === 1 ? "resp_ws_a" : "resp_ws_b";
			setTimeout(() => {
				ws.emit("response.completed", {
					type: "response.completed",
					sequence_number: 1,
					response: buildWsResponse(responseId),
				});
			}, 0);
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => ws,
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-chain-2" },
		);
		const secondCompletion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }, { role: "user", content: "hello 2" }] },
			{ sessionKey: "session-chain-2" },
		);

		const secondCreate = ws.sent[1];
		if (!secondCreate) {
			throw new Error("expected second ws request");
		}
		expect(secondCreate.previous_response_id).toBe("resp_ws_a");
		expect(Array.isArray(secondCreate.input)).toBe(true);
		if (!Array.isArray(secondCreate.input)) {
			throw new Error("expected array input");
		}
		expect(secondCreate.input.length).toBe(1);
		expect(secondCompletion.provider_meta).toEqual({
			response_id: "resp_ws_b",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: false,
			ws_reconnect_count: 0,
			ws_input_mode: "incremental",
		});
	});

	test("resets websocket connection when input must be fully regenerated", async () => {
		const mockClient = {
			responses: {
				stream: () => {
					throw new Error("http fallback should not be used");
				},
			},
		};
		const wsA = new MockResponsesSocket();
		const wsB = new MockResponsesSocket();
		let sendCount = 0;
		wsA.send = (event: ResponsesClientEvent): void => {
			wsA.sent.push(event);
			sendCount += 1;
			setTimeout(() => {
				wsA.emit("response.completed", {
					type: "response.completed",
					sequence_number: 1,
					response: buildWsResponse(sendCount === 1 ? "resp_ws_regen_a" : "resp_ws_regen_b"),
				});
			}, 0);
		};
		wsB.send = (event: ResponsesClientEvent): void => {
			wsB.sent.push(event);
			setTimeout(() => {
				wsB.emit("response.completed", {
					type: "response.completed",
					sequence_number: 1,
					response: buildWsResponse("resp_ws_regen_b"),
				});
			}, 0);
		};
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		await chat.ainvoke(
			{
				messages: [
					{ role: "user", content: "hello 1" },
					{ role: "user", content: "hello 2" },
				],
			},
			{ sessionKey: "session-chain-regenerated-1" },
		);
		const secondCompletion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-chain-regenerated-1" },
		);

		expect(createCount).toBe(2);
		expect(wsA.closeCount).toBe(1);
		expect(wsA.sent.length).toBe(1);
		expect(wsB.sent.length).toBe(1);
		const secondCreate = wsB.sent[0];
		if (!secondCreate) {
			throw new Error("expected regenerated ws request");
		}
		expect(secondCreate.previous_response_id).toBeUndefined();
		expect(secondCompletion.provider_meta).toEqual({
			response_id: "resp_ws_regen_b",
			transport: "ws_mode",
			websocket_mode: "auto",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_regenerated",
		});
	});

	test("reconnects with a new websocket when previous socket is closed", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		const wsB = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsA, "resp_ws_reconnect_a");
		installWsCompletedResponder(wsB, "resp_ws_reconnect_b");
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-reconnect-1" },
		);
		wsA.markClosed();
		const secondCompletion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-reconnect-1" },
		);

		expect(createCount).toBe(2);
		expect(wsA.closeCount).toBeGreaterThan(0);
		expect(wsB.sent.length).toBe(1);
		const secondCreate = wsB.sent[0];
		if (!secondCreate) {
			throw new Error("expected second websocket request");
		}
		expect(secondCreate.previous_response_id).toBeUndefined();
		expect(secondCompletion.provider_meta).toEqual({
			response_id: "resp_ws_reconnect_b",
			transport: "ws_mode",
			websocket_mode: "on",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_regenerated",
		});
	});

	test("reconnects with a new websocket when reuse idle window expires", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		const wsB = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsA, "resp_ws_idle_reuse_a");
		installWsCompletedResponder(wsB, "resp_ws_idle_reuse_b");
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		try {
			await chat.ainvoke(
				{ messages: [{ role: "user", content: "hello idle window 1" }] },
				{ sessionKey: "session-idle-window-1" },
			);
			now += 31_000;
			const secondCompletion = await chat.ainvoke(
				{ messages: [{ role: "user", content: "hello idle window 1" }] },
				{ sessionKey: "session-idle-window-1" },
			);

			expect(createCount).toBe(2);
			expect(wsA.closeCount).toBeGreaterThan(0);
			expect(secondCompletion.provider_meta).toEqual({
				response_id: "resp_ws_idle_reuse_b",
				transport: "ws_mode",
				websocket_mode: "on",
				fallback_used: false,
				chain_reset: true,
				ws_reconnect_count: 0,
				ws_input_mode: "full_regenerated",
			});
		} finally {
			Date.now = originalNow;
		}
	});

	test("evicts idle websocket session state by TTL", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		const wsB = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsA, "resp_ws_ttl_a");
		installWsCompletedResponder(wsB, "resp_ws_ttl_b");
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		try {
			await chat.ainvoke(
				{ messages: [{ role: "user", content: "hello ttl" }] },
				{ sessionKey: "session-ttl-1" },
			);
			now += 10 * 60_000 + 1;
			const secondCompletion = await chat.ainvoke(
				{ messages: [{ role: "user", content: "hello ttl" }] },
				{ sessionKey: "session-ttl-1" },
			);

			expect(createCount).toBe(2);
			expect(wsA.closeCount).toBeGreaterThan(0);
			const secondCreate = wsB.sent[0];
			if (!secondCreate) {
				throw new Error("expected second websocket request");
			}
			expect(secondCreate.previous_response_id).toBeUndefined();
			expect(secondCompletion.provider_meta).toEqual({
				response_id: "resp_ws_ttl_b",
				transport: "ws_mode",
				websocket_mode: "on",
				fallback_used: false,
				chain_reset: true,
				ws_reconnect_count: 0,
				ws_input_mode: "full_no_previous",
			});
		} finally {
			Date.now = originalNow;
		}
	});

	test("falls back to HTTP after previous_response_not_found for the same session", async () => {
		const calls: StreamCall[] = [];
		const mockClient = {
			responses: {
				stream: (
					request: ResponseCreateParamsStreaming,
					options?: StreamCall["options"],
				) => {
					calls.push({ request, options });
					return { finalResponse: async () => buildHttpResponse() };
				},
			},
		};
		const ws = new MockResponsesSocket();
		let sendCount = 0;
		ws.send = (event: ResponsesClientEvent): void => {
			ws.sent.push(event);
			sendCount += 1;
			setTimeout(() => {
				if (sendCount === 1) {
					ws.emit("response.completed", {
						type: "response.completed",
						sequence_number: 1,
						response: buildWsResponse("resp_ws_404"),
					});
					return;
				}
				ws.emit("response.failed", {
					type: "response.failed",
					sequence_number: 2,
					response: {
						error: {
							message: "previous response missing",
							code: "previous_response_not_found",
						},
					},
				});
			}, 0);
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => ws,
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-latch-1" },
		);
		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-latch-1" },
		);
		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-latch-1" },
		);

		expect(ws.sent.length).toBe(2);
		expect(calls.length).toBe(2);
	});

	test("disables websocket session after previous_response_not_found from error event", async () => {
		const calls: StreamCall[] = [];
		const mockClient = {
			responses: {
				stream: (
					request: ResponseCreateParamsStreaming,
					options?: StreamCall["options"],
				) => {
					calls.push({ request, options });
					return { finalResponse: async () => buildHttpResponse() };
				},
			},
		};
		const ws = new MockResponsesSocket();
		let sendCount = 0;
		ws.send = (event: ResponsesClientEvent): void => {
			ws.sent.push(event);
			sendCount += 1;
			setTimeout(() => {
				if (sendCount === 1) {
					ws.emit("response.completed", {
						type: "response.completed",
						sequence_number: 1,
						response: buildWsResponse("resp_ws_ok"),
					});
					return;
				}
				const error = new Error("previous_response_not_found");
				(
					error as Error & { error: { error: { code: string } } }
				).error = {
					error: { code: "previous_response_not_found" },
				};
				ws.emit("error", error);
			}, 0);
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => ws,
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-error-event-1" },
		);
		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-error-event-1" },
		);
		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hello 1" }] },
			{ sessionKey: "session-error-event-1" },
		);

		expect(ws.sent.length).toBe(2);
		expect(calls.length).toBe(2);
	});

	test("falls back to http in websocket_mode=auto when ws fails", async () => {
		const calls: StreamCall[] = [];
		const mockClient = {
			responses: {
				stream: (
					request: ResponseCreateParamsStreaming,
					options?: StreamCall["options"],
				) => {
					calls.push({ request, options });
					return { finalResponse: async () => buildHttpResponse() };
				},
			},
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "auto",
			createResponsesWs: () => {
				throw new Error("ws unavailable");
			},
		});
		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "say hello" }] },
			{ sessionKey: "session-ws-2" },
		);

		expect(calls).toHaveLength(1);
		expect(completion.provider_meta).toEqual({
			response_id: "resp_http_1",
			transport: "http_stream",
			websocket_mode: "auto",
			fallback_used: true,
			chain_reset: true,
			ws_reconnect_count: 1,
		});
	});

	test("throws when websocket_mode=on and ws fails", async () => {
		const mockClient = {
			baseURL: "https://api.openai.com/v1",
			responses: {
				stream: () => {
					throw new Error("should not fallback");
				},
			},
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				throw new Error("ws unavailable");
			},
		});

		expect(
			chat.ainvoke(
				{ messages: [{ role: "user", content: "say hello" }] },
				{ sessionKey: "session-ws-3" },
			),
		).rejects.toThrow("ws unavailable");
	});

	test("does not degrade to http in websocket_mode=on after previous_response_not_found", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		const wsB = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsA, "resp_ws_on_mode_a");
		let wsBSendCount = 0;
		wsB.send = (event: ResponsesClientEvent): void => {
			wsB.sent.push(event);
			wsBSendCount += 1;
			setTimeout(() => {
				if (wsBSendCount === 1) {
					wsB.emit("response.failed", {
						type: "response.failed",
						sequence_number: 1,
						response: {
							error: {
								message: "previous response missing",
								code: "previous_response_not_found",
							},
						},
					});
					return;
				}
				wsB.emit("response.completed", {
					type: "response.completed",
					sequence_number: 2,
					response: buildWsResponse("resp_ws_on_mode_c"),
				});
			}, 0);
		};
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		await chat.ainvoke(
			{ messages: [{ role: "user", content: "on mode 1" }] },
			{ sessionKey: "session-on-mode-latch-1" },
		);
		await expect(
			chat.ainvoke(
				{ messages: [{ role: "user", content: "on mode 2" }] },
				{ sessionKey: "session-on-mode-latch-1" },
			),
		).rejects.toThrow("previous response missing");
		const third = await chat.ainvoke(
			{ messages: [{ role: "user", content: "on mode 3" }] },
			{ sessionKey: "session-on-mode-latch-1" },
		);

		expect(createCount).toBeGreaterThanOrEqual(2);
		expect(wsB.sent.length).toBe(2);
		expect(third.provider_meta).toEqual({
			response_id: "resp_ws_on_mode_c",
			transport: "ws_mode",
			websocket_mode: "on",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 0,
			ws_input_mode: "full_no_previous",
		});
	});

	test("retries with fresh websocket in on mode when first ws request times out", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		wsA.send = () => {
			throw new Error("openai websocket response timeout");
		};
		const wsB = new StatefulMockResponsesSocket();
		wsB.send = (event: ResponsesClientEvent): void => {
			wsB.sent.push(event);
			setTimeout(() => {
				wsB.emit("response.completed", {
					type: "response.completed",
					sequence_number: 1,
					response: buildWsResponse("resp_ws_retry_timeout_b"),
				});
			}, 0);
		};
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "retry timeout" }] },
			{ sessionKey: "session-retry-timeout-1" },
		);

		expect(createCount).toBe(2);
		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_retry_timeout_b",
			transport: "ws_mode",
			websocket_mode: "on",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 1,
			ws_input_mode: "full_no_previous",
		});
	});

	test("retries up to three times in on mode for retryable websocket failures", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		wsA.send = () => {
			throw new Error("openai websocket response timeout");
		};
		const wsB = new StatefulMockResponsesSocket();
		wsB.send = () => {
			throw new Error("openai websocket response timeout");
		};
		const wsC = new StatefulMockResponsesSocket();
		wsC.send = () => {
			throw new Error("openai websocket closed before response code=1006");
		};
		const wsD = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsD, "resp_ws_retry_timeout_d");
		let createCount = 0;
		const sockets: StatefulMockResponsesSocket[] = [wsA, wsB, wsC, wsD];
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				const next = sockets[createCount];
				createCount += 1;
				if (!next) {
					throw new Error("unexpected websocket creation");
				}
				return next;
			},
		});

		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "retry timeout many" }] },
			{ sessionKey: "session-retry-timeout-many-1" },
		);

		expect(createCount).toBe(4);
		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_retry_timeout_d",
			transport: "ws_mode",
			websocket_mode: "on",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 3,
			ws_input_mode: "full_no_previous",
		});
	});

	test("stops retry loop in on mode when retry error becomes non-retryable", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new StatefulMockResponsesSocket();
		wsA.send = () => {
			throw new Error("openai websocket response timeout");
		};
		const wsB = new StatefulMockResponsesSocket();
		wsB.send = () => {
			throw new Error("previous response missing");
		};
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		await expect(
			chat.ainvoke(
				{ messages: [{ role: "user", content: "retry stop non retryable" }] },
				{ sessionKey: "session-retry-stop-1" },
			),
		).rejects.toThrow("previous response missing");
		expect(createCount).toBe(2);
	});

	test("cleans up pending ws promise when send throws synchronously", async () => {
		const mockClient = createWsOnlyMockClient();
		const ws = new StatefulMockResponsesSocket();
		ws.send = () => {
			setTimeout(() => {
				ws.emit("error", new Error("late ws error after sync send failure"));
			}, 0);
			throw new Error("sync send failure");
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => ws,
		});

		await expect(
			chat.ainvoke(
				{ messages: [{ role: "user", content: "sync send failure cleanup" }] },
				{ sessionKey: "session-sync-send-failure-1" },
			),
		).rejects.toThrow("sync send failure");

		await new Promise((resolve) => {
			setTimeout(resolve, 10);
		});
	});

	test("retries with fresh websocket when native socket closes without wrapper close event", async () => {
		const mockClient = createWsOnlyMockClient();
		const wsA = new NativeCloseOnlyMockResponsesSocket();
		wsA.send = (event: ResponsesClientEvent): void => {
			wsA.sent.push(event);
			setTimeout(() => {
				wsA.markNativeClosed();
			}, 0);
		};
		const wsB = new StatefulMockResponsesSocket();
		installWsCompletedResponder(wsB, "resp_ws_native_close_retry_b");
		let createCount = 0;
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => {
				createCount += 1;
				return createCount === 1 ? wsA : wsB;
			},
		});

		const completion = await chat.ainvoke(
			{ messages: [{ role: "user", content: "native close retry" }] },
			{ sessionKey: "session-native-close-retry-1" },
		);

		expect(createCount).toBe(2);
		expect(wsA.closeCount).toBeGreaterThan(0);
		expect(completion.provider_meta).toEqual({
			response_id: "resp_ws_native_close_retry_b",
			transport: "ws_mode",
			websocket_mode: "on",
			fallback_used: false,
			chain_reset: true,
			ws_reconnect_count: 1,
			ws_input_mode: "full_no_previous",
		});
	});

	test("preserves primary invoke error when close cleanup throws unexpected error", async () => {
		const mockClient = createWsOnlyMockClient();
		const ws = new ThrowingCloseMockResponsesSocket();
		ws.send = () => {
			throw new Error("send failed");
		};
		const chat = new ChatOpenAI({
			client: mockClient as never,
			model: "gpt-5",
			websocketMode: "on",
			createResponsesWs: () => ws,
		});

		await expect(
			chat.ainvoke(
				{ messages: [{ role: "user", content: "say hello" }] },
				{ sessionKey: "session-ws-close-fail-1" },
			),
		).rejects.toThrow("send failed");
	});

});
