import { describe, expect, test } from "bun:test";
import type { ResponsesProviderConfig } from "@codelia/config";
import { z } from "zod";
import { Agent } from "../src/agent/agent";
import { ChatResponses } from "../src/llm/responses/chat";
import { createModelRegistry } from "../src/models/registry";
import { CompactionService } from "../src/services/compaction/service";
import { defineTool } from "../src/tools/define";
import type { BaseMessage } from "../src/types/llm/messages";

const endpoint: ResponsesProviderConfig = {
	type: "responses",
	base_url: "https://gateway.test/v1",
	retry: "off",
	features: { encrypted_reasoning: true },
	models: {
		model: {
			context_window: 131072,
			supports_tools: true,
			supports_reasoning: true,
			supports_json_schema: true,
		},
	},
};
const registry = createModelRegistry([
	{
		id: "home/model",
		provider: "home",
		aliases: ["model"],
		contextWindow: 131072,
	},
]);
const message = (text: string) => ({
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const response = (output: unknown[]) => ({
	id: "resp_1",
	object: "response",
	created_at: 0,
	status: "completed",
	model: "model",
	output,
	usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});
const sse = (output: unknown[]) =>
	new Response(
		`: waiting for the backend to start\n\ndata: ${JSON.stringify({ type: "response.created", response: { ...response([]), status: "in_progress" } })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: response(output) })}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
const fetcher = (
	handler: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
) => Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;
const chat = (fetchImpl: typeof fetch, config = endpoint) =>
	new ChatResponses({
		provider: "home",
		model: "model",
		endpoint: config,
		apiKey: "test-home-key",
		reasoningEffort: "medium",
		fetch: fetchImpl,
	});

describe("named Responses transport", () => {
	for (const supportsVision of [false, true]) {
		test(`tool-result images respect supports_vision=${supportsVision} before sending`, async () => {
			const bodies: Record<string, unknown>[] = [];
			const llm = chat(
				fetcher(async (_input, init) => {
					bodies.push(JSON.parse(String(init?.body)));
					return sse([message("done")]);
				}),
				{
					...endpoint,
					models: {
						model: {
							...endpoint.models.model,
							supports_vision: supportsVision,
						},
					},
				},
			);
			const messages: BaseMessage[] = [
				{
					role: "tool",
					tool_call_id: "image-call",
					tool_name: "image_generate",
					content: [
						{ type: "text", text: "Generated image" },
						{
							type: "image_url",
							image_url: { url: "https://example.test/image.png" },
						},
					],
				},
			];
			if (!supportsVision) {
				await expect(llm.ainvoke({ messages })).rejects.toThrow("vision");
				expect(bodies).toHaveLength(0);
			} else {
				await llm.ainvoke({ messages });
				expect(bodies).toHaveLength(1);
				expect(bodies[0].input).toEqual([
					{
						type: "function_call_output",
						call_id: "image-call",
						output: [
							{ type: "input_text", text: "Generated image" },
							{
								type: "input_image",
								image_url: "https://example.test/image.png",
								detail: "auto",
							},
						],
					},
				]);
			}
		});
	}

	test("uses independent URL/auth, stateless defaults and replays two tool/reasoning turns", async () => {
		const calls: Array<{
			url: string;
			headers: Headers;
			body: Record<string, unknown>;
		}> = [];
		const llm = chat(
			fetcher(async (input, init) => {
				calls.push({
					url: String(input),
					headers: new Headers(init?.headers),
					body: JSON.parse(String(init?.body)),
				});
				const turn = calls.length;
				return sse(
					turn < 3
						? [
								{
									type: "reasoning",
									id: `rs_${turn}`,
									summary: [],
									content: [{ type: "reasoning_text", text: "plan" }],
									encrypted_content: `strata.r1:${turn}`,
								},
								{
									type: "function_call",
									id: `fc_${turn}`,
									call_id: `call_${turn}`,
									name: "lookup",
									arguments: "{}",
									status: "completed",
								},
							]
						: [message("done")],
				);
			}),
		);
		const tool = defineTool({
			name: "lookup",
			description: "lookup",
			input: z.object({}),
			execute: async () => "result",
		});
		const agent = new Agent({ llm, tools: [tool], modelRegistry: registry });
		expect(await agent.run("hello")).toBe("done");
		expect(calls).toHaveLength(3);
		for (const call of calls) {
			expect(call.url).toBe("https://gateway.test/v1/responses");
			expect(call.headers.get("authorization")).toBe("Bearer test-home-key");
			expect(call.headers.has("session_id")).toBe(false);
			expect(call.body).toMatchObject({
				store: false,
				stream: true,
				reasoning: { effort: "medium" },
				include: ["reasoning.encrypted_content"],
			});
			for (const key of [
				"previous_response_id",
				"background",
				"service_tier",
				"prompt_cache_key",
				"conversation",
			])
				expect(call.body[key]).toBeUndefined();
		}
		const replay = calls[2].body.input as Array<Record<string, unknown>>;
		expect(
			replay
				.filter((item) => item.type === "reasoning")
				.map((item) => item.encrypted_content),
		).toEqual(["strata.r1:1", "strata.r1:2"]);
		expect(
			replay
				.filter((item) => item.type === "function_call")
				.map((item) => item.id),
		).toEqual(["fc_1", "fc_2"]);
		expect(
			replay
				.filter((item) => item.type === "function_call_output")
				.map((item) => item.call_id),
		).toEqual(["call_1", "call_2"]);
	});

	for (const [status, code] of [
		[401, "invalid_api_key"],
		[404, "model_not_found"],
		[413, "request_too_large"],
		[429, "queue_full"],
		[503, "queue_timeout"],
		[504, "upstream_timeout"],
	] as const) {
		test(`retry off sends one POST and preserves HTTP ${status} / ${code}`, async () => {
			let calls = 0;
			const llm = chat(
				fetcher(async () => {
					calls++;
					return Response.json(
						{ error: { code, message: "secret upstream body" } },
						{ status },
					);
				}),
			);
			const agent = new Agent({
				llm,
				tools: [],
				modelRegistry: registry,
				llmMaxRetries: 5,
			});
			await expect(agent.run("hello")).rejects.toMatchObject({
				attempts: 1,
				failure: {
					status,
					code,
					retryable: false,
					safeMessage: expect.stringContaining(code),
				},
			});
			expect(calls).toBe(1);
		});
	}

	test("retry is opt-in and occurs only at the Agent layer", async () => {
		let calls = 0;
		const llm = chat(
			fetcher(async () =>
				++calls < 3
					? Response.json({ error: { code: "queue_full" } }, { status: 429 })
					: sse([message("done")]),
			),
			{ ...endpoint, retry: { max_retries: 2, base_delay_ms: 0 } },
		);
		const agent = new Agent({
			llm,
			tools: [],
			modelRegistry: registry,
			llmMaxRetries: 0,
		});
		expect(await agent.run("hi")).toBe("done");
		expect(calls).toBe(3);
	});

	test("stream errors and truncated streams are terminal without resending", async () => {
		for (const data of [
			`event: error\ndata: ${JSON.stringify({ type: "error", code: "backend_unavailable", message: "private details" })}\n\n`,
			`data: ${JSON.stringify({ type: "response.created", response: response([]) })}\n\n`,
		]) {
			let calls = 0;
			const llm = chat(
				fetcher(async () => {
					calls++;
					return new Response(data, {
						headers: { "content-type": "text/event-stream" },
					});
				}),
			);
			await expect(
				new Agent({ llm, tools: [], modelRegistry: registry }).run("hi"),
			).rejects.toMatchObject({ attempts: 1 });
			expect(calls).toBe(1);
		}
	});

	test("rejects hosted tools, images and unsupported reasoning before sending", async () => {
		let calls = 0;
		const llm = chat(
			fetcher(async () => {
				calls++;
				return sse([message("done")]);
			}),
		);
		await expect(
			llm.ainvoke({
				messages: [],
				tools: [{ type: "hosted_search", name: "web_search" }],
			}),
		).rejects.toThrow("hosted tools");
		await expect(
			llm.ainvoke({
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image_url",
								image_url: { url: "https://example.test/image.png" },
							},
						],
					},
				],
			}),
		).rejects.toThrow("vision");
		await expect(
			llm.ainvoke({ messages: [], options: { reasoningEffort: "max" } }),
		).rejects.toThrow("reasoning effort");
		await expect(
			llm.ainvoke({ messages: [], model: "toString" }),
		).rejects.toThrow("Unknown model");
		expect(calls).toBe(0);
	});

	test("connection failure is not retried when the endpoint disables retry", async () => {
		let calls = 0;
		const llm = chat(
			fetcher(async () => {
				calls++;
				throw new TypeError("connection lost");
			}),
		);
		await expect(
			new Agent({ llm, tools: [], modelRegistry: registry }).run("hi"),
		).rejects.toMatchObject({
			attempts: 1,
			failure: { kind: "network", retryable: false },
		});
		expect(calls).toBe(1);
	});

	test("cancelling a comment-only cold-start stream terminates without resending", async () => {
		let calls = 0;
		let connected!: () => void;
		const ready = new Promise<void>((resolve) => {
			connected = resolve;
		});
		const llm = chat(
			fetcher(async (_input, init) => {
				calls++;
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								": waiting for the backend to start\n\n",
							),
						);
						init?.signal?.addEventListener(
							"abort",
							() =>
								controller.error(new DOMException("cancelled", "AbortError")),
							{ once: true },
						);
						connected();
					},
				});
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			}),
		);
		const controller = new AbortController();
		const pending = llm.ainvoke({
			messages: [{ role: "user", content: "hi" }],
			signal: controller.signal,
		});
		await ready;
		controller.abort();
		await expect(pending).rejects.toMatchObject({
			failure: { kind: "cancelled", retryable: false },
		});
		expect(calls).toBe(1);
	});

	test("a broken successful stream is never retried even when pre-stream retry is enabled", async () => {
		let calls = 0;
		const llm = chat(
			fetcher(async () => {
				calls++;
				return new Response(
					new ReadableStream({
						start(controller) {
							queueMicrotask(() =>
								controller.error(new TypeError("stream lost")),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}),
			{ ...endpoint, retry: { max_retries: 2, base_delay_ms: 0 } },
		);
		await expect(
			new Agent({ llm, tools: [], modelRegistry: registry }).run("hi"),
		).rejects.toMatchObject({
			attempts: 1,
			failure: { retryable: false, delivery: "buffered" },
		});
		expect(calls).toBe(1);
	});

	test("compaction uses config-derived limits and the same Responses transport", async () => {
		let calls = 0;
		const llm = chat(
			fetcher(async () => {
				calls++;
				return sse([message("Preserve the earlier decision.")]);
			}),
		);
		const service = new CompactionService(
			{ thresholdRatio: 0.8 },
			{ modelRegistry: registry },
		);
		expect(
			await service.shouldCompact(llm, {
				model: "model",
				input_tokens: 110000,
				output_tokens: 1,
				total_tokens: 110001,
			}),
		).toBe(true);
		const result = await service.compact(llm, [
			{ role: "user", content: "earlier" },
			{ role: "assistant", content: "decision" },
		]);
		expect(result.compacted).toBe(true);
		expect(calls).toBe(1);
	});

	test("optional OpenAI extensions stay absent unless explicitly enabled", async () => {
		let body: Record<string, unknown> = {};
		const llm = chat(
			fetcher(async (_input, init) => {
				body = JSON.parse(String(init?.body));
				return sse([message("done")]);
			}),
			{ ...endpoint, features: {} },
		);
		await llm.ainvoke(
			{ messages: [{ role: "user", content: "hi" }] },
			{ sessionKey: "session" },
		);
		expect(body.include).toBeUndefined();
		expect(body.reasoning).toEqual({ effort: "medium" });
		expect(body.prompt_cache_key).toBeUndefined();
	});
});
