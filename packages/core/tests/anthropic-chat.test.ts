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
	test("uses a longer default sdk timeout", () => {
		const chat = new ChatAnthropic({
			clientOptions: {
				apiKey: "test-key",
			},
			model: "claude-sonnet-4-5",
		});

		expect(
			(chat as never as { client: { timeout: number } }).client.timeout,
		).toBe(20 * 60 * 1000);
	});

	test("preserves explicit sdk timeout override", () => {
		const chat = new ChatAnthropic({
			clientOptions: {
				apiKey: "test-key",
				timeout: 45_000,
			},
			model: "claude-sonnet-4-5",
		});

		expect(
			(chat as never as { client: { timeout: number } }).client.timeout,
		).toBe(45_000);
	});

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

	test("uses beta fast mode request path when enabled", async () => {
		const standardCalls: MessageCreateCall[] = [];
		const betaCalls: Array<{
			request: MessageCreateParamsNonStreaming & {
				speed?: "standard" | "fast" | null;
				betas?: string[];
			};
			options?: MessageCreateCall["options"];
		}> = [];
		const mockClient = {
			messages: {
				create: (
					request: MessageCreateParamsNonStreaming,
					options?: MessageCreateCall["options"],
				) => {
					standardCalls.push({ request, options });
					return Promise.resolve(buildMockMessage());
				},
			},
			beta: {
				messages: {
					create: (
						request: MessageCreateParamsNonStreaming & {
							speed?: "standard" | "fast" | null;
							betas?: string[];
						},
						options?: MessageCreateCall["options"],
					) => {
						betaCalls.push({ request, options });
						return Promise.resolve(buildMockMessage());
					},
				},
			},
		};
		const chat = new ChatAnthropic({
			client: mockClient as never,
			model: "claude-opus-4-6",
			fastMode: true,
		});

		await chat.ainvoke({
			messages: [{ role: "user", content: "say hello fast" }],
		});

		expect(standardCalls).toHaveLength(0);
		expect(betaCalls).toHaveLength(1);
		expect(betaCalls[0]?.request.speed).toBe("fast");
		expect(betaCalls[0]?.request.betas).toContain("fast-mode-2026-02-01");
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

	test("applies default invokeOptions thinking and exposes reasoning metadata", async () => {
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
			invokeOptions: {
				thinking: {
					type: "enabled",
					budget_tokens: 8192,
				},
			},
			reasoningLevelRequested: "xhigh",
			reasoningLevelApplied: "high",
			reasoningFallbackApplied: true,
			reasoningBudgetPreset: "reasoning_high",
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.thinking).toEqual({
			type: "enabled",
			budget_tokens: 8192,
		});
		expect(completion.provider_meta).toMatchObject({
			reasoning_requested: "xhigh",
			reasoning_applied: "high",
			reasoning_fallback: true,
			reasoning_budget_preset: "reasoning_high",
		});
	});
});
