import { describe, expect, test } from "bun:test";
import { APIUserAbortError } from "@anthropic-ai/sdk";
import type {
	Message,
	MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { ChatAnthropic } from "../src/llm/anthropic/chat";
import type { BaseMessage, ToolDefinition } from "../src/types/llm";

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
	test.each([
		["claude-opus-4-6", false],
		["claude-opus-4-6", true],
		["claude-sonnet-5-5", false],
		["claude-haiku-5-5", false],
	] as const)(
		"restores actual SDK SSE output and timing (%s, fast=%s)",
		async (model, fastMode) => {
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
				model,
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

describe("Claude Sonnet/Haiku 5.5", () => {
	const tools = [
		{
			type: "function",
			name: "lookup",
			description: "Look up a value",
			parameters: { type: "object", properties: {} },
		},
	] satisfies ToolDefinition[];
	const makeClient = (model: string) => {
		const requests: MessageCreateParamsNonStreaming[] = [];
		const responses: Message[] = [];
		const client = streamingMockClient({
			messages: {
				create: async (request: MessageCreateParamsNonStreaming) => {
					requests.push(structuredClone(request));
					const index = requests.length;
					const response = {
						...buildMockMessage(),
						model,
						stop_reason: "tool_use",
						content: [
							{
								type: "thinking",
								thinking: "",
								signature: `signature-${index}`,
							},
							{ type: "text", text: `progress-${index}`, citations: null },
							{
								type: "tool_use",
								id: `call-${index}`,
								name: "lookup",
								input: { value: index },
							},
							{ type: "redacted_thinking", data: `opaque-${index}` },
						],
					} as Message;
					responses.push(response);
					return response;
				},
			},
		});
		return {
			requests,
			responses,
			chat: new ChatAnthropic({
				model,
				client: client as never,
				invokeOptions: {
					thinking: { type: "adaptive" },
					output_config: { effort: "max" },
				},
			}),
		};
	};
	const result = (index: number): BaseMessage => ({
		role: "tool",
		tool_call_id: `call-${index}`,
		tool_name: "lookup",
		content: `result-${index}`,
	});
	const sentThinking = (request: MessageCreateParamsNonStreaming) =>
		request.messages.flatMap((message) =>
			typeof message.content === "string"
				? []
				: message.content.filter(
						(block) =>
							block.type === "thinking" || block.type === "redacted_thinking",
					),
		);

	test.each(["claude-sonnet-5-5", "claude-haiku-5-5"])(
		"%s replays signed blocks in exact order after durable resume",
		async (model) => {
			const { chat, requests, responses } = makeClient(model);
			const messages: BaseMessage[] = [
				{ role: "system", content: "fixed system" },
				{ role: "user", content: "look it up" },
			];
			const first = await chat.ainvoke({ messages, tools });
			const saved = JSON.parse(
				JSON.stringify([...messages, ...first.messages, result(1)]),
			) as BaseMessage[];
			const before = JSON.stringify(saved);
			await chat.ainvoke({ messages: saved, tools });
			expect(requests[0]?.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
			});
			expect(requests[0]?.output_config?.effort).toBe("max");
			expect(requests[1]?.messages[1]).toEqual({
				role: "assistant",
				content: responses[0]?.content,
			});
			expect(JSON.stringify(requests[1])).not.toContain(
				"codelia_anthropic_prefix_sha256",
			);
			expect(JSON.stringify(saved)).toBe(before);
			// A new adapter has no in-memory prefix state.
			const resumed = makeClient(model);
			await resumed.chat.ainvoke({ messages: saved, tools });
			expect(resumed.requests[0]?.messages).toEqual(requests[1]?.messages);
		},
	);

	test.each([
		"system",
		"tools",
		"user",
		"tool-result",
		"assistant-text",
		"thinking-gap",
	])(
		"removes invalid reasoning after a %s edit and preserves new reasoning",
		async (edit) => {
			const { chat, requests } = makeClient("claude-sonnet-5-5");
			const messages: BaseMessage[] = [
				{ role: "system", content: "fixed" },
				{ role: "user", content: "start" },
			];
			const first = await chat.ainvoke({ messages, tools });
			messages.push(...first.messages, result(1));
			const second = await chat.ainvoke({ messages, tools });
			messages.push(...second.messages, result(2));
			let currentTools = tools;
			if (edit === "system")
				messages[0] = { role: "system", content: "changed" };
			if (edit === "user") messages[1] = { role: "user", content: "changed" };
			if (edit === "tools")
				currentTools = [{ ...tools[0], description: "changed" }];
			if (edit === "tool-result")
				messages[messages.findIndex((message) => message.role === "tool")] = {
					...result(1),
					content: "shortened",
				};
			if (edit === "assistant-text") {
				const text = messages.find(
					(message) =>
						message.role === "assistant" && message.content === "progress-1",
				);
				if (text) text.content = "edited";
			}
			if (edit === "thinking-gap")
				messages.splice(
					messages.findIndex((message) => message.role === "reasoning"),
					1,
				);
			const third = await chat.ainvoke({ messages, tools: currentTools });
			expect(
				sentThinking(requests[2]).some(
					(block) =>
						block.type === "thinking" && block.signature === "signature-2",
				),
			).toBe(false);
			if (["system", "tools", "user", "thinking-gap"].includes(edit))
				expect(sentThinking(requests[2])).toHaveLength(0);
			messages.push(...third.messages, result(3));
			await chat.ainvoke({ messages, tools: currentTools });
			expect(
				sentThinking(requests[3]).some(
					(block) =>
						block.type === "thinking" && block.signature === "signature-3",
				),
			).toBe(true);
			expect(
				sentThinking(requests[3]).some(
					(block) =>
						block.type === "thinking" && block.signature === "signature-2",
				),
			).toBe(false);
		},
	);

	test.each(["required", "lookup"])(
		"rejects Sonnet forced tool choice before transport (%j)",
		async (toolChoice) => {
			const { chat, requests } = makeClient("claude-sonnet-5-5");
			await expect(
				chat.ainvoke({
					messages: [{ role: "user", content: "start" }],
					tools,
					toolChoice,
				}),
			).rejects.toThrow("does not support required or named tool choice");
			expect(requests).toHaveLength(0);
		},
	);

	test.each(["required", "lookup"])(
		"preserves Haiku forced tool choice (%s)",
		async (toolChoice) => {
			const { chat, requests } = makeClient("claude-haiku-5-5");
			await chat.ainvoke({
				messages: [{ role: "user", content: "start" }],
				tools,
				toolChoice,
			});
			expect(requests[0]?.tool_choice).toEqual(
				toolChoice === "required"
					? { type: "any" }
					: { type: "tool", name: "lookup" },
			);
		},
	);

	test.each([
		{ temperature: 1 },
		{ top_p: 1 },
		{ top_k: 10 },
		{ thinking: { type: "enabled" as const, budget_tokens: 2048 } },
	])("rejects unsupported options before transport (%j)", async (options) => {
		const { chat, requests } = makeClient("claude-haiku-5-5");
		await expect(
			chat.ainvoke({ messages: [{ role: "user", content: "start" }], options }),
		).rejects.toThrow("Claude Sonnet/Haiku 5.5");
		expect(requests).toHaveLength(0);
	});

	test("rejects assistant prefill and drops unbound foreign reasoning", async () => {
		const { chat, requests } = makeClient("claude-sonnet-5-5");
		await expect(
			chat.ainvoke({
				messages: [
					{ role: "user", content: "start" },
					{ role: "assistant", content: "prefill" },
				],
			}),
		).rejects.toThrow("assistant prefill");
		expect(requests).toHaveLength(0);
		await chat.ainvoke({
			messages: [
				{
					role: "reasoning",
					content: "foreign",
					raw_item: { type: "reasoning", id: "other-provider" },
				},
				{
					role: "reasoning",
					content: "legacy",
					raw_item: {
						type: "thinking",
						thinking: "legacy",
						signature: "unbound",
					},
				},
				{ role: "user", content: "start" },
			],
		});
		expect(requests[0]?.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "start" }] },
		]);
	});

	test("keeps Haiku disabled thinking and validates direct Fast selection", async () => {
		const { chat, requests } = makeClient("claude-haiku-5-5");
		await chat.ainvoke({
			messages: [{ role: "user", content: "start" }],
			options: { thinking: { type: "disabled" } },
		});
		expect(requests[0]?.thinking).toEqual({ type: "disabled" });
		await expect(
			chat.ainvoke({
				messages: [{ role: "user", content: "start" }],
				options: { speed: "fast" },
			}),
		).rejects.toThrow("do not support Fast");
		expect(requests).toHaveLength(1);
	});

	test("preserves native hosted search blocks and citations before later thinking", async () => {
		const model = "claude-sonnet-5-5";
		const response = {
			...buildMockMessage(),
			model,
			content: [
				{
					type: "server_tool_use",
					id: "search-1",
					name: "web_search",
					input: { query: "example" },
				},
				{
					type: "web_search_tool_result",
					tool_use_id: "search-1",
					content: [
						{
							type: "web_search_result",
							url: "https://example.com",
							title: "Example",
							encrypted_content: "opaque",
							page_age: null,
						},
					],
				},
				{
					type: "text",
					text: "result",
					citations: [
						{
							type: "web_search_result_location",
							url: "https://example.com",
							title: "Example",
							encrypted_index: "opaque-index",
							cited_text: "example",
						},
					],
				},
				{
					type: "thinking",
					thinking: "summary",
					signature: "search-signature",
				},
			],
		} as Message;
		const requests: MessageCreateParamsNonStreaming[] = [];
		const client = streamingMockClient({
			messages: {
				create: async (request: MessageCreateParamsNonStreaming) => {
					requests.push(structuredClone(request));
					return response;
				},
			},
		});
		const chat = new ChatAnthropic({ model, client: client as never });
		const messages: BaseMessage[] = [{ role: "user", content: "search" }];
		const search: ToolDefinition[] = [
			{ type: "hosted_search", provider: "anthropic", name: "web_search" },
		];
		const first = await chat.ainvoke({ messages, tools: search });
		await chat.ainvoke({
			messages: [
				...messages,
				...first.messages,
				{ role: "user", content: "continue" },
			],
			tools: search,
		});
		expect(requests[1]?.messages[1]).toEqual({
			role: "assistant",
			content: response.content,
		});
	});
});
