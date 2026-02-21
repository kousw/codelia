import { describe, expect, test } from "bun:test";
import type {
	Message,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { ChatAnthropic } from "../src/llm/anthropic/chat";

type MessageCreateCall = {
	request: MessageCreateParamsNonStreaming;
	options?: { signal?: AbortSignal };
};

const buildMockMessage = (): Message =>
	({
		id: "msg_anthropic_1",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-5",
		container: null,
		stop_reason: "end_turn",
		stop_sequence: null,
		content: [{ type: "text", text: "hello", citations: null }],
		usage: {
			input_tokens: 8,
			output_tokens: 4,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
	}) as unknown as Message;

describe("ChatAnthropic", () => {
	test("enables automatic prompt cache control by default", async () => {
		const calls: MessageCreateCall[] = [];
		const mockClient = {
			messages: {
				create: (
					request: MessageCreateParamsNonStreaming,
					options?: MessageCreateCall["options"],
				) => {
					calls.push({ request, options });
					return Promise.resolve(buildMockMessage());
				},
			},
		};
		const chat = new ChatAnthropic({
			client: mockClient as never,
			model: "claude-sonnet-4-5",
		});

		await chat.ainvoke({
			messages: [{ role: "user", content: "say hello" }],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.cache_control).toEqual({ type: "ephemeral" });
	});

	test("respects explicit cache_control override", async () => {
		const calls: MessageCreateCall[] = [];
		const mockClient = {
			messages: {
				create: (
					request: MessageCreateParamsNonStreaming,
					options?: MessageCreateCall["options"],
				) => {
					calls.push({ request, options });
					return Promise.resolve(buildMockMessage());
				},
			},
		};
		const chat = new ChatAnthropic({
			client: mockClient as never,
			model: "claude-sonnet-4-5",
		});

		await chat.ainvoke({
			messages: [{ role: "user", content: "say hello" }],
			options: {
				cache_control: null,
			},
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.cache_control).toBeNull();
	});

	test("normalizes usage input_tokens as total including cache read/create", async () => {
		const calls: MessageCreateCall[] = [];
		const mockClient = {
			messages: {
				create: (
					request: MessageCreateParamsNonStreaming,
					options?: MessageCreateCall["options"],
				) => {
					calls.push({ request, options });
					return Promise.resolve({
						...buildMockMessage(),
						usage: {
							input_tokens: 3,
							output_tokens: 123,
							cache_read_input_tokens: 62_122,
							cache_creation_input_tokens: 262,
						},
					});
				},
			},
		};
		const chat = new ChatAnthropic({
			client: mockClient as never,
			model: "claude-sonnet-4-5",
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "check usage normalization" }],
		});

		expect(calls).toHaveLength(1);
		expect(completion.usage).toMatchObject({
			input_tokens: 62_387,
			input_cached_tokens: 62_122,
			input_cache_creation_tokens: 262,
			output_tokens: 123,
			total_tokens: 62_510,
		});
	});
});
