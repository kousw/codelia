import { expect, spyOn, test } from "bun:test";
import type {
	Response,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { ChatOpenAI } from "../src/llm/openai/chat";
import { ChatOpenRouter } from "../src/llm/openrouter/chat";
import { ChatXai } from "../src/llm/xai/chat";

test.each(["openai", "openrouter", "xai"] as const)(
	"%s HTTP adapter attaches first-output timing to the completion",
	async (provider) => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const response = {
				id: "resp_1",
				model: "test",
				status: "completed",
				output: [],
				usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
			} as unknown as Response;
			const client = {
				responses: {
					stream: () => ({
						async *[Symbol.asyncIterator]() {
							now = 9000;
							yield {
								type: "response.created",
								response,
								sequence_number: 0,
							} as ResponseStreamEvent;
							now = 10_000;
							yield {
								type: "response.output_text.delta",
								delta: "hello",
								item_id: "msg_1",
								output_index: 0,
								content_index: 0,
							} as ResponseStreamEvent;
							now = 12_000;
							yield {
								type: "response.completed",
								sequence_number: 2,
								response,
							} as ResponseStreamEvent;
						},
						async finalResponse() {
							now = 20_000;
							return response;
						},
					}),
				},
			};
			const options = { client: client as never, model: "test" };
			const chat =
				provider === "openai"
					? new ChatOpenAI({ ...options, websocketMode: "off" })
					: provider === "openrouter"
						? new ChatOpenRouter(options)
						: new ChatXai(options);
			const completion = await chat.ainvoke({
				messages: [{ role: "user", content: "hi" }],
			});
			expect(completion.timing).toEqual({
				time_to_first_token_ms: 10_000,
				generation_duration_ms: 2000,
			});
		} finally {
			clock.mockRestore();
		}
	},
);

test.each([false, true])(
	"OpenAI successful transport owns timing across WS/HTTP fallback (fallback=%s)",
	async (fallback) => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const response = {
				id: "resp_1",
				model: "test",
				status: "completed",
				output: [],
				usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
			} as unknown as Response;
			const listeners = new Map<string, Set<(event: unknown) => void>>();
			const emit = (name: string, event: unknown) => {
				for (const listener of [...(listeners.get(name) ?? [])])
					listener(event);
			};
			const ws = {
				on(name: string, listener: (event: unknown) => void) {
					const entries = listeners.get(name) ?? new Set();
					entries.add(listener);
					listeners.set(name, entries);
					return this;
				},
				off(name: string, listener: (event: unknown) => void) {
					listeners.get(name)?.delete(listener);
					return this;
				},
				close() {},
				send() {
					now = 10_000;
					emit("event", {
						type: "response.output_text.delta",
						delta: "hello",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
					});
					now = 12_000;
					if (fallback) emit("error", new Error("could not send data"));
					else
						emit("response.completed", {
							type: "response.completed",
							response,
						});
				},
			};
			let httpCalls = 0;
			const client = {
				responses: {
					stream: () => {
						httpCalls++;
						return {
							async *[Symbol.asyncIterator]() {
								now = 22_000;
								yield {
									type: "response.output_text.delta",
									delta: "hello",
									item_id: "msg_1",
									output_index: 0,
									content_index: 0,
								} as ResponseStreamEvent;
								now = 24_000;
								yield {
									type: "response.completed",
									response,
								} as ResponseStreamEvent;
							},
							async finalResponse() {
								now = 30_000;
								return response;
							},
						};
					},
				},
			};
			const chat = new ChatOpenAI({
				client: client as never,
				model: "test",
				websocketMode: "auto",
				createResponsesWs: () => ws,
			});
			const completion = await chat.ainvoke(
				{ messages: [{ role: "user", content: "hi" }] },
				{ sessionKey: "test-session" },
			);
			expect(httpCalls).toBe(fallback ? 1 : 0);
			expect(completion.timing).toEqual({
				time_to_first_token_ms: 10_000,
				generation_duration_ms: 2000,
			});
		} finally {
			clock.mockRestore();
		}
	},
);
