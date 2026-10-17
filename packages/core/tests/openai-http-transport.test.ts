import { expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import type {
	Response,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { invokeOpenAiHttp } from "../src/llm/openai/http-transport";
import { ChatOpenAI } from "../src/llm/openai/chat";

const codexBase = "https://chatgpt.com/backend-api/codex";
const response = {
	id: "resp_test",
	object: "response",
	model: "test",
	status: "completed",
	output: [],
	usage: { input_tokens: 10, output_tokens: 12, total_tokens: 22 },
} as unknown as Response;
const metadata = {
	type: "response.metadata",
	response_id: response.id,
	sequence_number: 4,
	metadata: {
		type: "safety_buffering",
		openai_verification_recommendation: "fixture",
	},
};
const progress = [
	{
		type: "response.created",
		response: { ...response, status: "in_progress" },
	},
	{
		type: "response.output_item.added",
		output_index: 0,
		item: {
			id: "msg_test",
			type: "message",
			role: "assistant",
			status: "in_progress",
			content: [],
		},
	},
	{
		type: "response.content_part.added",
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "", annotations: [] },
	},
	{
		type: "response.output_text.delta",
		output_index: 0,
		content_index: 0,
		item_id: "msg_test",
		delta: "hello",
	},
];
const completed = { type: "response.completed", response };
const encode = (event: unknown) =>
	new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

function clientFor(events: unknown[], baseURL = codexBase) {
	const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
	const client = new OpenAI({
		apiKey: async () => "test-oauth-token",
		baseURL,
		maxRetries: 0,
		fetch: async (input, init) => {
			requests.push({
				url: String(input),
				headers: new Headers(init?.headers),
				body: JSON.parse(String(init?.body)),
			});
			return new globalThis.Response(
				new ReadableStream({
					start(controller) {
						for (const event of events) controller.enqueue(encode(event));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	return { client, requests };
}

test("Codex extension metadata reaches observers and preserves completed text, tools, reasoning and usage", async () => {
	const tool = {
		type: "function_call" as const,
		id: "fc_test",
		call_id: "call_test",
		name: "read",
		arguments: "{}",
		status: "completed" as const,
	};
	const reasoning = {
		type: "reasoning" as const,
		id: "reason_test",
		summary: [{ type: "summary_text" as const, text: "think" }],
	};
	const { client, requests } = clientFor([
		...progress,
		metadata,
		{ type: "response.output_item.done", output_index: 1, item: tool },
		{ type: "response.output_item.done", output_index: 2, item: reasoning },
		completed,
	]);
	const helper = spyOn(client.responses, "stream");
	const seen: unknown[] = [];
	try {
		const result = await invokeOpenAiHttp(
			client,
			{ model: "test", input: "hi", store: false },
			undefined,
			"session_test",
			(event) => {
				seen.push(event);
			},
		);
		expect(helper).not.toHaveBeenCalled();
		expect(seen).toContainEqual(metadata);
		expect(result.output).toHaveLength(3);
		expect(result.output[0]).toMatchObject({ content: [{ text: "hello" }] });
		expect(result.output[1]).toEqual(tool);
		expect(result.output[2]).toEqual(reasoning);
		expect(result.usage).toEqual(response.usage);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(`${codexBase}/responses`);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-oauth-token",
		);
		expect(requests[0].headers.get("session_id")).toBe("session_test");
		expect(requests[0].body).toMatchObject({ store: false, stream: true });
	} finally {
		helper.mockRestore();
	}
});

test.each([
	"https://api.openai.com/v1",
	"https://api.x.ai/v1",
	"https://example.com/backend-api/codex",
])("%s retains the SDK stream helper", async (baseURL) => {
	const { client } = clientFor([progress[0], completed], baseURL);
	const helper = spyOn(client.responses, "stream");
	try {
		expect(
			(await invokeOpenAiHttp(client, { model: "test", input: "hi" })).status,
		).toBe("completed");
		expect(helper).toHaveBeenCalledTimes(1);
	} finally {
		helper.mockRestore();
	}
});

test("Codex failed and truncated streams never become partial success or replay", async () => {
	for (const terminal of [
		[],
		[
			{
				type: "response.failed",
				response: {
					...response,
					status: "failed",
					error: { code: "server_error", message: "failure" },
				},
			},
		],
	]) {
		const { client, requests } = clientFor([
			...progress,
			metadata,
			...terminal,
		]);
		const error = await invokeOpenAiHttp(client, {
			model: "test",
			input: "hi",
		}).catch((err: unknown) => err);
		if (terminal.length) expect(error).toMatchObject({ code: "server_error" });
		else expect(error).toBeInstanceOf(Error);
		expect(requests).toHaveLength(1);
	}
});

test("Codex incomplete response remains incomplete", async () => {
	const { client } = clientFor([
		...progress,
		{
			type: "response.incomplete",
			response: {
				...response,
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			},
		},
	]);
	const result = await invokeOpenAiHttp(client, { model: "test", input: "hi" });
	expect(result.status).toBe("incomplete");
	expect(result.output[0]).toMatchObject({ content: [{ text: "hello" }] });
});

test("Codex cancellation while awaiting more SSE stays an APIUserAbortError", async () => {
	const abort = new AbortController();
	let requests = 0;
	const client = new OpenAI({
		apiKey: "test-token",
		baseURL: codexBase,
		maxRetries: 0,
		fetch: async (_input, init) => {
			requests++;
			return new globalThis.Response(
				new ReadableStream({
					start(controller) {
						for (const event of progress) controller.enqueue(encode(event));
						init?.signal?.addEventListener("abort", () => controller.close(), {
							once: true,
						});
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	await expect(
		invokeOpenAiHttp(
			client,
			{ model: "test", input: "hi" },
			abort.signal,
			undefined,
			(event) => {
				if (event.type === "response.output_text.delta")
					setTimeout(() => abort.abort(), 0);
			},
		),
	).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
	expect(requests).toBe(1);
});

test("Codex adapter preserves first-output TPS timing with extension events", async () => {
	let now = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => now);
	const { client } = clientFor([...progress, metadata, completed]);
	const clone = spyOn(client, "withOptions").mockImplementation(() => client);
	const create = client.responses.create.bind(client.responses);
	const stub = spyOn(client.responses, "create").mockImplementation(
		(...args) => {
			const pending = create(...args);
			return pending.then((stream) => ({
				async *[Symbol.asyncIterator]() {
					for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
						now =
							event.type === "response.completed"
								? 12000
								: event.type === "response.output_text.delta"
									? 10000
									: now;
						yield event;
					}
				},
			})) as never;
		},
	);
	try {
		const chat = new ChatOpenAI({
			client,
			model: "test",
			websocketMode: "off",
		});
		const result = await chat.ainvoke({
			messages: [{ role: "user", content: "hi" }],
		});
		expect(result.timing).toEqual({
			time_to_first_token_ms: 10000,
			generation_duration_ms: 2000,
		});
	} finally {
		clock.mockRestore();
		stub.mockRestore();
		clone.mockRestore();
	}
});
