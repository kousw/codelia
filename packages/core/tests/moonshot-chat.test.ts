import { describe, expect, test } from "bun:test";
import { ChatMoonshot } from "../src/llm/moonshot/chat";
import {
	appendMoonshotChatCompletionChunk,
	createMoonshotStreamAccumulator,
	toMoonshotChatInvokeCompletion,
	toMoonshotMessages,
} from "../src/llm/moonshot/serializer";
import type { BaseMessage } from "../src/types/llm";

const sse = (chunks: unknown[]): string =>
	[
		...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
		"data: [DONE]\n\n",
	].join("");

const buildMockFetch = (
	impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(impl, { preconnect: fetch.preconnect });

describe("ChatMoonshot", () => {
	test("streams Kimi K3 reasoning and sends the native Moonshot contract", async () => {
		const calls: Array<{ input: URL | RequestInfo; init?: RequestInit }> = [];
		const fetchImpl = buildMockFetch(async (input, init) => {
			calls.push({ input, init });
			return new Response(
				sse([
					{
						id: "cmpl_k3_1",
						model: "kimi-k3",
						choices: [{ delta: { reasoning_content: "plan " } }],
					},
					{
						id: "cmpl_k3_1",
						model: "kimi-k3",
						choices: [{ delta: { content: "done" }, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 20,
							completion_tokens: 5,
							total_tokens: 25,
							cached_tokens: 12,
						},
					},
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const chat = new ChatMoonshot({
			apiKey: "test-moonshot-key",
			baseURL: "https://example.test/v1/",
			fetch: fetchImpl,
			reasoningLevelRequested: "medium",
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "work" }],
		});

		expect(chat.provider).toBe("moonshot");
		expect(String(calls[0]?.input)).toBe(
			"https://example.test/v1/chat/completions",
		);
		expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(
			"Bearer test-moonshot-key",
		);
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			model: "kimi-k3",
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: "max",
			messages: [{ role: "user", content: "work" }],
		});
		expect(body).not.toHaveProperty("thinking");
		expect(completion.messages).toEqual([
			expect.objectContaining({ role: "reasoning", content: "plan " }),
			{ role: "assistant", content: "done" },
		]);
		expect(completion.usage).toEqual({
			model: "kimi-k3",
			input_tokens: 20,
			input_cached_tokens: 12,
			output_tokens: 5,
			total_tokens: 25,
		});
		expect(completion.provider_meta).toMatchObject({
			reasoning_requested: "medium",
			reasoning_applied: "max",
			reasoning_effort: "max",
			reasoning_fallback: true,
		});
	});

	test("sends function tools and normalizes streamed tool-call arguments", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = buildMockFetch(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				sse([
					{
						id: "cmpl_k3_tools",
						model: "kimi-k3",
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: { name: "lookup", arguments: '{"q"' },
										},
									],
								},
							},
						],
					},
					{
						choices: [
							{
								delta: {
									tool_calls: [{ index: 0, function: { arguments: ':"x"}' } }],
								},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const chat = new ChatMoonshot({ apiKey: "key", fetch: fetchImpl });

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "look up" }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					strict: false,
					parameters: { type: "object", properties: { q: { type: "string" } } },
				},
			],
			toolChoice: "required",
		});

		expect(bodies[0]?.tool_choice).toBe("required");
		expect(bodies[0]?.tools).toEqual([
			{
				type: "function",
				function: {
					name: "lookup",
					description: "Look up a value",
					strict: false,
					parameters: {
						type: "object",
						properties: { q: { type: "string" } },
					},
				},
			},
		]);
		expect(completion.messages[0]).toMatchObject({
			role: "assistant",
			tool_calls: [
				{
					id: "call_1",
					function: { name: "lookup", arguments: '{"q":"x"}' },
					provider_meta: { provider: "moonshot", raw_chunk_count: 2 },
				},
			],
		});
	});

	test("sends inline image parts as a multimodal array", async () => {
		const bodies: Record<string, unknown>[] = [];
		const fetchImpl = buildMockFetch(async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(
				sse([
					{
						id: "cmpl_k3_vision",
						model: "kimi-k3",
						choices: [{ delta: { content: "seen" }, finish_reason: "stop" }],
					},
				]),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const chat = new ChatMoonshot({ apiKey: "key", fetch: fetchImpl });

		await chat.ainvoke({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{
							type: "image_url",
							image_url: {
								url: "data:image/png;base64,AAAA",
								media_type: "image/png",
								detail: "high",
							},
						},
					],
				},
			],
		});

		expect(bodies[0]?.messages).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AAAA" },
					},
				],
			},
		]);
	});

	test("rejects public image URLs before network I/O", async () => {
		let fetchCalled = false;
		const chat = new ChatMoonshot({
			apiKey: "key",
			fetch: buildMockFetch(async () => {
				fetchCalled = true;
				return new Response();
			}),
		});

		await expect(
			chat.ainvoke({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: { url: "https://example.com/image.png" },
							},
						],
					},
				],
			}),
		).rejects.toThrow("public image URLs are not supported");
		expect(fetchCalled).toBe(false);
	});
});

describe("Moonshot serializer", () => {
	test("replays Moonshot reasoning on the complete assistant message", () => {
		const messages: BaseMessage[] = [
			{
				role: "reasoning",
				content: "private plan",
				raw_item: { provider: "moonshot", field: "reasoning_content" },
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "lookup",
				content: "result",
			},
		];

		expect(toMoonshotMessages(messages)).toEqual([
			{
				role: "assistant",
				content: null,
				reasoning_content: "private plan",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "result" },
		]);
	});

	test("preserves multiple supported image inputs and ignores foreign reasoning", () => {
		expect(
			toMoonshotMessages([
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{
							type: "image_url",
							image_url: {
								url: "data:image/png;base64,AA==",
								media_type: "image/png",
							},
						},
						{
							type: "image_url",
							image_url: { url: "ms://file_123" },
						},
					],
				},
				{
					role: "reasoning",
					content: "do not replay",
					raw_item: { provider: "zai" },
				},
				{ role: "assistant", content: "ok" },
			]),
		).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AA==" },
					},
					{
						type: "image_url",
						image_url: { url: "ms://file_123" },
					},
				],
			},
			{ role: "assistant", content: "ok" },
		]);
	});

	for (const mediaType of ["png", "jpeg", "webp", "gif"] as const) {
		test(`accepts base64 ${mediaType} image input`, () => {
			expect(
				toMoonshotMessages([
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: {
									url: `data:image/${mediaType};base64,AAAA`,
									media_type: `image/${mediaType}`,
								},
							},
						],
					},
				]),
			).toEqual([
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: {
								url: `data:image/${mediaType};base64,AAAA`,
							},
						},
					],
				},
			]);
		});
	}

	test("rejects mismatched image media types", () => {
		expect(() =>
			toMoonshotMessages([
				{
					role: "user",
					content: [
						{
							type: "image_url",
							image_url: {
								url: "data:image/png;base64,AAAA",
								media_type: "image/jpeg",
							},
						},
					],
				},
			]),
		).toThrow("Moonshot image media_type mismatch");
	});

	test("defers tool images until every consecutive tool result is present", () => {
		const messages: BaseMessage[] = [
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "view_image", arguments: "{}" },
					},
					{
						id: "call_2",
						type: "function",
						function: { name: "view_image", arguments: "{}" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "view_image",
				content: [
					{ type: "text", text: "first image" },
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AAAA" },
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_2",
				tool_name: "view_image",
				content: [
					{
						type: "image_url",
						image_url: { url: "data:image/webp;base64,BBBB" },
					},
				],
			},
		];

		expect(toMoonshotMessages(messages)).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "view_image", arguments: "{}" },
					},
					{
						id: "call_2",
						type: "function",
						function: { name: "view_image", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "first image" },
			{
				role: "tool",
				tool_call_id: "call_2",
				content:
					"Tool view_image returned image output attached in the following user message.",
			},
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Image output from tool view_image (call call_1).",
					},
					{
						type: "image_url",
						image_url: { url: "data:image/png;base64,AAAA" },
					},
					{
						type: "text",
						text: "Image output from tool view_image (call call_2).",
					},
					{
						type: "image_url",
						image_url: { url: "data:image/webp;base64,BBBB" },
					},
				],
			},
		]);
	});

	test("normalizes a direct accumulator for deterministic usage coverage", () => {
		const accumulator = createMoonshotStreamAccumulator();
		appendMoonshotChatCompletionChunk(accumulator, {
			id: "cmpl_direct",
			model: "kimi-k3",
			choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		});
		expect(
			toMoonshotChatInvokeCompletion(accumulator, {
				reasoningRequested: "max",
				reasoningFallback: false,
			}),
		).toMatchObject({
			usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
			provider_meta: { reasoning_fallback: false },
		});
	});
});
