import { describe, expect, test } from "bun:test";
import type {
	Response,
	ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import { ChatOpenRouter } from "../src/llm/openrouter/chat";

type StreamCall = {
	request: ResponseCreateParamsStreaming;
	options?: { headers?: Record<string, string>; signal?: AbortSignal };
};

const buildMockResponse = (): Response =>
	({
		id: "resp_openrouter_1",
		model: "openai/gpt-5",
		status: "completed",
		output_text: "hello",
		output: [
			{
				type: "message",
				id: "msg_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "hello", annotations: [] }],
			},
		],
		usage: {
			input_tokens: 10,
			output_tokens: 5,
			total_tokens: 15,
			input_tokens_details: {
				cached_tokens: 0,
			},
		},
	}) as unknown as Response;

describe("ChatOpenRouter", () => {
	test("uses provider=openrouter and streams via responses API", async () => {
		const calls: StreamCall[] = [];
		const mockClient = {
			responses: {
				stream: (
					request: ResponseCreateParamsStreaming,
					options?: StreamCall["options"],
				) => {
					calls.push({ request, options });
					return {
						finalResponse: async () => buildMockResponse(),
					};
				},
			},
		};
		const chat = new ChatOpenRouter({
			client: mockClient as never,
			model: "openai/gpt-5",
		});

		const completion = await chat.ainvoke(
			{
				messages: [{ role: "user", content: "say hello" }],
			},
			{ sessionKey: "session-openrouter-1" },
		);

		expect(chat.provider).toBe("openrouter");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.stream).toBe(true);
		expect(calls[0]?.request.model).toBe("openai/gpt-5");
		expect(calls[0]?.options?.headers?.session_id).toBe("session-openrouter-1");
		expect(completion.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			},
		]);
	});
});
