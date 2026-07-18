import { describe, expect, test } from "bun:test";
import type {
	Response,
	ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";
import { ChatXai } from "../src/llm/xai/chat";
import {
	toXaiChatInvokeCompletion,
	toXaiResponsesInput,
	toXaiResponsesTools,
} from "../src/llm/xai/serializer";

const buildResponse = (): Response =>
	({
		id: "resp_xai_1",
		created_at: 0,
		error: null,
		incomplete_details: null,
		instructions: null,
		metadata: null,
		model: "grok-4.5",
		object: "response",
		status: "completed",
		output_text: "done",
		output: [
			{
				type: "reasoning",
				id: "rs_xai_1",
				summary: [{ type: "summary_text", text: "plan" }],
				encrypted_content: "encrypted-xai-reasoning",
			},
			{
				type: "function_call",
				id: "fc_xai_1",
				call_id: "call_xai_1",
				name: "lookup",
				arguments: '{"q":"x"}',
				status: "completed",
			},
			{
				type: "message",
				id: "msg_xai_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "done", annotations: [] }],
			},
		],
		parallel_tool_calls: true,
		temperature: 1,
		tool_choice: "auto",
		tools: [],
		top_p: 1,
		truncation: "disabled",
		usage: {
			input_tokens: 20,
			output_tokens: 8,
			total_tokens: 28,
			input_tokens_details: { cached_tokens: 12 },
			output_tokens_details: { reasoning_tokens: 3 },
		},
		user: null,
	}) as unknown as Response;

describe("ChatXai", () => {
	test("uses the configured xAI base URL and bearer auth", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = Object.assign(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				calls.push({
					url: String(input),
					headers: new Headers(init?.headers),
				});
				const response = buildResponse();
				const created = {
					...response,
					status: "in_progress",
					output: [],
					output_text: "",
				};
				return new globalThis.Response(
					[
						`data: ${JSON.stringify({
							type: "response.created",
							sequence_number: 0,
							response: created,
						})}\n\n`,
						`data: ${JSON.stringify({
							type: "response.completed",
							sequence_number: 1,
							response,
						})}\n\n`,
						"data: [DONE]\n\n",
					].join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: fetch.preconnect },
		) as typeof fetch;
		const chat = new ChatXai({
			clientOptions: {
				apiKey: "test-xai-key",
				baseURL: "https://example.test/xai/v1/",
				fetch: fetchImpl,
			},
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "hello" }],
		});

		expect(completion.messages.at(-1)).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://example.test/xai/v1/responses");
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer test-xai-key");
	});

	test("sends the xAI Responses contract and normalizes reasoning, tools, and usage", async () => {
		const calls: ResponseCreateParamsStreaming[] = [];
		const client = {
			responses: {
				stream: (request: ResponseCreateParamsStreaming) => {
					calls.push(request);
					return { finalResponse: async () => buildResponse() };
				},
			},
		};
		const chat = new ChatXai({
			client: client as never,
			reasoningEffort: "medium",
			reasoningLevelRequested: "max",
			reasoningLevelApplied: "high",
			reasoningFallbackApplied: true,
		});

		const completion = await chat.ainvoke(
			{
				messages: [
					{ role: "system", content: "Be useful." },
					{
						role: "user",
						content: [
							{ type: "text", text: "inspect" },
							{
								type: "image_url",
								image_url: { url: "data:image/png;base64,AAAA" },
							},
						],
					},
				],
				tools: [
					{
						name: "lookup",
						description: "Look up a value",
						parameters: { type: "object", properties: {} },
						strict: false,
					},
					{
						type: "hosted_search",
						name: "web_search",
						provider: "xai",
					},
				],
				toolChoice: "required",
			},
			{ sessionKey: "session-xai-1" },
		);

		expect(chat.provider).toBe("xai");
		expect(chat.model).toBe("grok-4.5");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			model: "grok-4.5",
			instructions: "Be useful.",
			store: false,
			stream: true,
			reasoning: { effort: "medium" },
			prompt_cache_key: "session-xai-1",
			tool_choice: "required",
		});
		expect(calls[0]?.include).toEqual(
			expect.arrayContaining([
				"reasoning.encrypted_content",
				"web_search_call.action.sources",
			]),
		);
		expect(calls[0]?.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "function", name: "lookup" }),
				expect.objectContaining({ type: "web_search" }),
			]),
		);
		expect(completion.messages).toEqual([
			expect.objectContaining({ role: "reasoning", content: "plan" }),
			expect.objectContaining({
				role: "assistant",
				tool_calls: [
					expect.objectContaining({
						id: "call_xai_1",
						function: { name: "lookup", arguments: '{"q":"x"}' },
					}),
				],
			}),
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			},
		]);
		expect(completion.usage).toEqual({
			model: "grok-4.5",
			provider_model: "grok-4.5",
			input_tokens: 20,
			input_cached_tokens: 12,
			output_tokens: 8,
			total_tokens: 28,
		});
		expect(completion.provider_meta).toMatchObject({
			response_id: "resp_xai_1",
			transport: "http_stream",
			reasoning_requested: "max",
			reasoning_applied: "high",
			reasoning_fallback: true,
		});
	});

	test("preserves xAI reasoning and function-call replay", () => {
		const input = toXaiResponsesInput([
			{
				role: "reasoning",
				content: "plan",
				raw_item: {
					type: "reasoning",
					id: "rs_xai_replay",
					summary: [],
					encrypted_content: "encrypted",
				},
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_xai_replay",
						type: "function",
						function: { name: "lookup", arguments: "{}" },
						provider_meta: {
							type: "function_call",
							id: "fc_xai_replay",
							call_id: "call_xai_replay",
							name: "lookup",
							arguments: "{}",
							status: "completed",
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_xai_replay",
				tool_name: "lookup",
				content: "ok",
			},
		]);

		expect(input).toEqual([
			expect.objectContaining({ type: "reasoning", id: "rs_xai_replay" }),
			expect.objectContaining({
				type: "function_call",
				id: "fc_xai_replay",
				call_id: "call_xai_replay",
			}),
			{
				type: "function_call_output",
				call_id: "call_xai_replay",
				output: "ok",
			},
		]);
	});

	test("serializes X Search alongside web search with xAI-specific options", () => {
		const tools = toXaiResponsesTools([
			{
				type: "hosted_search",
				name: "web_search",
				provider: "xai",
			},
			{
				type: "hosted_search",
				search_kind: "x",
				name: "x_search",
				provider: "xai",
				allowed_x_handles: [" @xai ", "openai"],
				from_date: "2026-01-01",
				to_date: "2026-07-19",
				enable_image_understanding: true,
				enable_video_understanding: false,
			},
		]);

		expect(tools).toEqual([
			expect.objectContaining({ type: "web_search" }),
			{
				type: "x_search",
				allowed_x_handles: ["xai", "openai"],
				from_date: "2026-01-01",
				to_date: "2026-07-19",
				enable_image_understanding: true,
				enable_video_understanding: false,
			},
		]);
	});

	test("rejects invalid X Search filters before serialization", () => {
		const xSearch = {
			type: "hosted_search" as const,
			search_kind: "x" as const,
			name: "x_search" as const,
			provider: "xai" as const,
		};
		expect(() =>
			toXaiResponsesTools([
				{
					...xSearch,
					allowed_x_handles: Array.from(
						{ length: 21 },
						(_, index) => `handle_${index}`,
					),
				},
			]),
		).toThrow("at most 20 allowed_x_handles; received 21");
		expect(() =>
			toXaiResponsesTools([
				{
					...xSearch,
					allowed_x_handles: ["xai"],
					excluded_x_handles: ["spam"],
				},
			]),
		).toThrow(
			"allowed_x_handles and excluded_x_handles are mutually exclusive",
		);
		expect(() =>
			toXaiResponsesTools([
				{ ...xSearch, allowed_x_handles: ["not a handle"] },
			]),
		).toThrow("must contain bare X handles");
		expect(() =>
			toXaiResponsesTools([{ ...xSearch, from_date: "2026-02-30" }]),
		).toThrow("from_date must use a valid YYYY-MM-DD date");
		expect(() =>
			toXaiResponsesTools([
				{ ...xSearch, from_date: "2026-07-20", to_date: "2026-07-19" },
			]),
		).toThrow("from_date must be on or before to_date");
	});

	test("normalizes, retains citations, and replays x_search_call output", () => {
		const xSearchCall = {
			type: "x_search_call" as const,
			id: "xs_1",
			status: "completed",
			action: {
				queries: ["from:xai Grok"],
				sources: [{ type: "x", url: "https://x.com/xai/status/1" }],
			},
		};
		const citation = {
			type: "url_citation",
			url: "https://x.com/xai/status/1",
			start_index: 0,
			end_index: 4,
		};
		const response = {
			...buildResponse(),
			output: [
				xSearchCall,
				{
					type: "message",
					id: "msg_x_search",
					status: "completed",
					role: "assistant",
					content: [
						{ type: "output_text", text: "result", annotations: [citation] },
					],
				},
			],
		} as unknown as Response;

		const completion = toXaiChatInvokeCompletion(response);
		expect(completion.messages[0]).toEqual({
			role: "reasoning",
			content: "XSearch status=completed | queries=from:xai Grok | sources=1",
			raw_item: xSearchCall,
		});
		expect(completion.provider_meta).toMatchObject({ citations: [citation] });
		expect(toXaiResponsesInput([completion.messages[0] as never])).toEqual([
			xSearchCall,
		]);
	});

	test("rejects unsupported inline image media before transport", async () => {
		let called = false;
		const chat = new ChatXai({
			client: {
				responses: {
					stream: () => {
						called = true;
						return { finalResponse: async () => buildResponse() };
					},
				},
			} as never,
		});

		await expect(
			chat.ainvoke({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: { url: "data:image/webp;base64,AAAA" },
							},
						],
					},
				],
			}),
		).rejects.toThrow("image/jpeg and image/png only");
		expect(called).toBe(false);
	});

	test("emits only supported xAI web search fields", () => {
		const allowedDomains = [
			"one.example",
			"two.example",
			"three.example",
			"four.example",
			"five.example",
		];

		const tools = toXaiResponsesTools([
			{
				type: "hosted_search",
				name: "web_search",
				provider: "xai",
				search_context_size: "medium",
				allowed_domains: allowedDomains,
				user_location: { country: "JP", timezone: "Asia/Tokyo" },
			},
		]);

		expect(tools).toEqual([
			{
				type: "web_search",
				filters: { allowed_domains: allowedDomains },
			},
		]);
	});

	test("rejects more than five xAI web search allowed domains before transport", async () => {
		let called = false;
		const chat = new ChatXai({
			client: {
				responses: {
					stream: () => {
						called = true;
						return { finalResponse: async () => buildResponse() };
					},
				},
			} as never,
		});

		await expect(
			chat.ainvoke({
				messages: [{ role: "user", content: "search" }],
				tools: [
					{
						type: "hosted_search",
						name: "web_search",
						provider: "xai",
						allowed_domains: [
							"one.example",
							"two.example",
							"three.example",
							"four.example",
							"five.example",
							"six.example",
						],
					},
				],
			}),
		).rejects.toThrow(
			"xAI web search supports at most 5 allowed_domains; received 6",
		);
		expect(called).toBe(false);
	});
});
