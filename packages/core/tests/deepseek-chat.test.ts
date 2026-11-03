import { expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { ChatDeepSeek } from "../src/llm/deepseek/chat";
import { DEEPSEEK_MODELS } from "../src/models/deepseek";

const usage = {
	input_tokens: 10,
	output_tokens: 5,
	total_tokens: 15,
	input_tokens_details: { cached_tokens: 4 },
	output_tokens_details: { reasoning_tokens: 3 },
};
const message = {
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: "done", annotations: [] }],
};
const response = (output: unknown[] = [message], status = "completed") => ({
	id: "resp_1",
	object: "response",
	created_at: 1,
	model: "deepseek-flash",
	status,
	output,
	usage,
	incomplete_details:
		status === "incomplete" ? { reason: "max_output_tokens" } : null,
});
const sse = (value: ReturnType<typeof response>) =>
	new Response(
		`event: response.${value.status}\ndata: ${JSON.stringify({ type: `response.${value.status}`, sequence_number: 1, response: value })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const fixtureFetch = (handler: (request: Request) => Promise<Response>) =>
	Object.assign(
		async (input: URL | RequestInfo, init?: RequestInit) =>
			handler(new Request(input, init)),
		{ preconnect: fetch.preconnect },
	) as typeof fetch;

test.each(DEEPSEEK_MODELS)(
	"DeepSeek $id sends only its stateless Responses contract",
	async (model) => {
		let posts = 0;
		const chat = new ChatDeepSeek({
			apiKey: "fixture",
			model: model.id,
			reasoningEffort: "max",
			fetch: fixtureFetch(async (request) => {
				posts++;
				expect(request.url).toBe("https://api.deepseek.com/responses");
				expect(request.headers.get("authorization")).toBe("Bearer fixture");
				const body = await request.json();
				expect(body).toMatchObject({
					model: model.id,
					store: false,
					stream: true,
					reasoning: { effort: "max" },
					max_output_tokens: 384_000,
				});
				for (const key of [
					"include",
					"previous_response_id",
					"conversation",
					"service_tier",
					"prompt_cache_key",
					"metadata",
					"text",
				])
					expect(body).not.toHaveProperty(key);
				return sse({ ...response(), model: model.id });
			}),
		});
		const result = await chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
		});
		expect(posts).toBe(1);
		expect(result.usage).toMatchObject({
			model: model.id,
			input_cached_tokens: 4,
			output_tokens: 5,
			output_reasoning_tokens: 3,
			total_tokens: 15,
		});
	},
);

test.each([
	["low", "low"],
	["medium", "high"],
	["high", "high"],
	["xhigh", "high"],
	["max", "max"],
] as const)(
	"DeepSeek maps %s effort to %s and reports it",
	async (requested, applied) => {
		const chat = new ChatDeepSeek({
			apiKey: "fixture",
			reasoningEffort: requested,
			fetch: fixtureFetch(async (request) => {
				expect((await request.json()).reasoning).toEqual({ effort: applied });
				return sse(response());
			}),
		});
		const result = await chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
		});
		expect(result.provider_meta).toMatchObject({
			reasoning_requested: requested,
			reasoning_applied: applied,
			reasoning_fallback: requested !== applied,
		});
	},
);

test("DeepSeek reasoning and function identity survive stateless tool replay", async () => {
	let posts = 0;
	const thought = {
		type: "reasoning",
		id: "rs_1",
		summary: [],
		content: [{ type: "reasoning_text", text: "Need a tool." }],
	};
	const call = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "lookup",
		arguments: '{"value":1}',
		status: "completed",
	};
	const chat = new ChatDeepSeek({
		apiKey: "fixture",
		fetch: fixtureFetch(async (request) => {
			posts++;
			const body = await request.json();
			if (posts === 1) return sse(response([thought, call]));
			expect(body.input).toEqual(
				expect.arrayContaining([
					thought,
					expect.objectContaining({
						type: "function_call",
						call_id: "call_1",
						name: "lookup",
						arguments: '{"value":1}',
					}),
					{ type: "function_call_output", call_id: "call_1", output: "one" },
				]),
			);
			return sse(response());
		}),
	});
	const user = { role: "user" as const, content: "lookup" };
	const first = await chat.ainvoke({
		messages: [user],
		tools: [
			{
				name: "lookup",
				description: "Look up a value",
				parameters: { type: "object" },
			},
		],
	});
	expect(first.messages[0]).toMatchObject({
		role: "reasoning",
		content: "Need a tool.",
		raw_item: thought,
	});
	await chat.ainvoke({
		messages: [
			user,
			...first.messages,
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "lookup",
				content: "one",
			},
		],
	});
	expect(posts).toBe(2);
});

test("DeepSeek Pro rejects image input before HTTP while Flash accepts it", async () => {
	let posts = 0;
	const fake = fixtureFetch(async () => {
		posts++;
		return sse(response());
	});
	const messages = [
		{
			role: "user" as const,
			content: [
				{
					type: "image_url" as const,
					image_url: { url: "data:image/png;base64,YQ==" },
				},
			],
		},
	];
	await expect(
		new ChatDeepSeek({
			apiKey: "fixture",
			model: "deepseek-v4-pro",
			fetch: fake,
		}).ainvoke({ messages }),
	).rejects.toThrow("vision is disabled");
	expect(posts).toBe(0);
	await new ChatDeepSeek({ apiKey: "fixture", fetch: fake }).ainvoke({
		messages,
	});
	expect(posts).toBe(1);
});

test("DeepSeek rejects incomplete and truncated streams without exposing partial calls", async () => {
	for (const result of [
		sse(response([message], "incomplete")),
		new Response(
			'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		),
	]) {
		const chat = new ChatDeepSeek({
			apiKey: "fixture",
			fetch: fixtureFetch(async () => result),
		});
		await expect(
			chat.ainvoke({ messages: [{ role: "user", content: "hi" }] }),
		).rejects.toThrow();
	}
});

test("DeepSeek never multiplies POSTs through SDK or Agent retry", async () => {
	let posts = 0;
	const chat = new ChatDeepSeek({
		apiKey: "fixture",
		fetch: fixtureFetch(async () => {
			posts++;
			return new Response(
				JSON.stringify({
					error: { message: "upstream-secret-body", code: "server_error" },
				}),
				{ status: 500, headers: { "content-type": "application/json" } },
			);
		}),
	});
	const agent = new Agent({ llm: chat, tools: [] });
	await expect(agent.run("hi")).rejects.toThrow();
	expect(posts).toBe(1);
	const failure = chat.classifyFailure({
		status: 500,
		message: "upstream-secret-body",
	});
	expect(failure.safeMessage).not.toContain("upstream-secret-body");
	expect(failure.retryable).toBe(false);
});

test("DeepSeek preserves caller cancellation and resolves only registered models", async () => {
	let posts = 0;
	const chat = new ChatDeepSeek({
		apiKey: "fixture",
		model: "default",
		fetch: fixtureFetch(async () => {
			posts++;
			return sse(response());
		}),
	});
	expect(chat.model).toBe("deepseek-flash");
	expect(
		() => new ChatDeepSeek({ apiKey: "fixture", model: "deepseek-old" }),
	).toThrow("Unsupported DeepSeek model");
	const controller = new AbortController();
	controller.abort();
	await expect(
		chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
			signal: controller.signal,
		}),
	).rejects.toThrow();
	expect(posts).toBe(0);
});

test("DeepSeek refuses forced named tools before HTTP", async () => {
	let posts = 0;
	const chat = new ChatDeepSeek({
		apiKey: "fixture",
		fetch: fixtureFetch(async () => {
			posts++;
			return sse(response());
		}),
	});
	await expect(
		chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{
					name: "lookup",
					description: "Lookup",
					parameters: { type: "object" },
				},
			],
			toolChoice: "lookup",
		}),
	).rejects.toThrow("forced named tool choice");
	expect(posts).toBe(0);
});
