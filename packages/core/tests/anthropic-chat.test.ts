import { describe, expect, test } from "bun:test";
import { APIUserAbortError } from "@anthropic-ai/sdk";
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

// Mock the SDK streaming boundary while keeping request/normalization assertions.
const streamingMockClient = <
	T extends { messages: unknown; beta?: { messages: unknown } },
>(
	client: T,
) => {
	const messages = (source: unknown) => {
		const api = source as {
			create: (
				request: MessageCreateParamsNonStreaming,
				options?: MessageCreateCall["options"],
			) => Promise<Message>;
		};
		return {
			stream(
				request: MessageCreateParamsNonStreaming,
				options?: MessageCreateCall["options"],
			) {
				const final = Promise.resolve().then(() =>
					api.create(request, options),
				);
				return {
					async *[Symbol.asyncIterator]() {
						await final;
						yield {
							type: "content_block_delta",
							delta: { type: "text_delta", text: "hello" },
						};
						yield { type: "message_stop" };
					},
					finalMessage: () => final,
				};
			},
		};
	};
	return {
		...client,
		messages: messages(client.messages),
		...(client.beta
			? { beta: { messages: messages(client.beta.messages) } }
			: {}),
	};
};

describe("ChatAnthropic", () => {
	test.each([false, true])(
		"restores actual SDK SSE output and timing (fast=%s)",
		async (fastMode) => {
			const calls: { body: Record<string, unknown>; headers: Headers }[] = [];
			const fetchImpl = Object.assign(
				async (_input: URL | RequestInfo, init?: RequestInit) => {
					calls.push({
						body: JSON.parse(String(init?.body)),
						headers: new Headers(init?.headers),
					});
					const message = buildMockMessage();
					const events = [
						{
							type: "message_start",
							message: {
								...message,
								content: [],
								stop_reason: null,
								usage: { ...message.usage, output_tokens: 0 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "hello" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 4 },
						},
						{ type: "message_stop" },
					];
					return new Response(
						events
							.map(
								(event) =>
									`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
							)
							.join(""),
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
				{ preconnect: fetch.preconnect },
			);
			const chat = new ChatAnthropic({
				model: "claude-opus-4-6",
				fastMode,
				clientOptions: { apiKey: "test-key", fetch: fetchImpl },
			});
			const completion = await chat.ainvoke({
				messages: [{ role: "user", content: "hi" }],
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.body.stream).toBe(true);
			expect(completion.messages[0]?.content).toBe("hello");
			expect(completion.usage?.output_tokens).toBe(4);
			expect(completion.timing?.generation_duration_ms).toBeGreaterThanOrEqual(
				0,
			);
			if (fastMode) {
				expect(calls[0]?.body.speed).toBe("fast");
				expect(calls[0]?.headers.get("anthropic-beta")).toContain(
					"fast-mode-2026-02-01",
				);
			}
		},
	);

	test("cancels an in-flight SDK stream without returning a partial completion", async () => {
		const abort = new AbortController();
		let responseStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			responseStarted = resolve;
		});
		const fetchImpl = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				responseStarted();
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							init?.signal?.addEventListener(
								"abort",
								() =>
									controller.error(new DOMException("Aborted", "AbortError")),
								{ once: true },
							);
							controller.enqueue(new TextEncoder().encode(": waiting\n\n"));
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: fetch.preconnect },
		);
		const chat = new ChatAnthropic({
			clientOptions: { apiKey: "test-key", fetch: fetchImpl },
		});
		const pending = chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
			signal: abort.signal,
		});
		await started;
		abort.abort();
		await expect(pending).rejects.toBeInstanceOf(APIUserAbortError);
	}, 5_000);

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
			client: streamingMockClient(mockClient) as never,
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
			client: streamingMockClient(mockClient) as never,
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

	test("passes distinct adaptive xhigh and max effort options", async () => {
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
		for (const effort of ["xhigh", "max"] as const) {
			const chat = new ChatAnthropic({
				client: streamingMockClient(mockClient) as never,
				model: "claude-opus-4-7",
				invokeOptions: {
					thinking: { type: "adaptive" },
					output_config: { effort },
				},
			});
			await chat.ainvoke({
				messages: [{ role: "user", content: `think at ${effort} effort` }],
			});
		}

		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.request.thinking)).toEqual([
			{ type: "adaptive" },
			{ type: "adaptive" },
		]);
		expect(
			calls.map((call) => String(call.request.output_config?.effort)),
		).toEqual(["xhigh", "max"]);
	});

	test("sends adaptive max effort for new Claude models", async () => {
		const calls: MessageCreateCall[] = [];
		const mockClient = {
			messages: {
				create: (request: MessageCreateParamsNonStreaming) => {
					calls.push({ request });
					return Promise.resolve(buildMockMessage());
				},
			},
		};
		for (const model of [
			"claude-fable-5-1",
			"claude-opus-5-5",
			"claude-sonnet-5",
		]) {
			const chat = new ChatAnthropic({
				client: streamingMockClient(mockClient) as never,
				model,
				invokeOptions: {
					thinking: { type: "adaptive" },
					output_config: { effort: "max" },
				},
			});
			await chat.ainvoke({
				messages: [{ role: "user", content: "think deeply" }],
			});
		}
		expect(calls.map((call) => call.request.model)).toEqual([
			"claude-fable-5-1",
			"claude-opus-5-5",
			"claude-sonnet-5",
		]);
		expect(
			calls.every((call) => call.request.thinking?.type === "adaptive"),
		).toBe(true);
		expect(
			calls.every((call) => call.request.output_config?.effort === "max"),
		).toBe(true);
	});

	test("surfaces Fable refusal details and discards partial output", async () => {
		const mockClient = {
			messages: {
				create: () =>
					Promise.resolve({
						...buildMockMessage(),
						model: "claude-fable-5",
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation:
								"This request was declined because it could enable cyber harm.",
						},
						content: [
							{ type: "text", text: "partial output", citations: null },
						],
					}),
			},
		};
		const chat = new ChatAnthropic({
			client: streamingMockClient(mockClient) as never,
			model: "claude-fable-5",
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "trigger classifier" }],
		});

		expect(completion.messages).toEqual([
			{
				role: "assistant",
				content: null,
				refusal:
					"This request was declined because it could enable cyber harm.",
			},
		]);
		expect(completion.stop_reason).toBe("refusal");
		expect(completion.provider_meta).toMatchObject({
			raw_output_text: "",
			stop_details: {
				type: "refusal",
				category: "cyber",
				explanation:
					"This request was declined because it could enable cyber harm.",
			},
		});
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
			client: streamingMockClient(mockClient) as never,
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
			client: streamingMockClient(mockClient) as never,
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
			client: streamingMockClient(mockClient) as never,
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
