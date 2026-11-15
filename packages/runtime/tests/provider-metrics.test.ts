import { expect, spyOn, test } from "bun:test";
import {
	type BaseChatModel,
	ChatAnthropic,
	ChatDeepSeek,
	ChatMoonshot,
	ChatOpenAI,
	ChatOpenRouter,
	ChatResponses,
	ChatXai,
	ChatZai,
} from "@codelia/core";
import type { BuiltinProviderName } from "@codelia/shared-types";
import { buildRunMetrics } from "../src/rpc/run-metrics";

// Exercise real SDK/adapter normalization through runtime TPS, without network.
// Google has text/tool/hidden-thought boundary coverage in google-metrics.test.ts.
// Adding a builtin provider requires a fixture here (Google is covered separately).
const transports = {
	openai: "responses",
	openrouter: "responses",
	xai: "responses",
	deepseek: "responses",
	responses: "responses",
	anthropic: "anthropic",
	moonshot: "chat",
	zai: "chat",
} as const satisfies Record<
	Exclude<BuiltinProviderName, "google"> | "responses",
	"responses" | "anthropic" | "chat"
>;

test.each(Object.keys(transports) as (keyof typeof transports)[])(
	"%s provider completion supplies usable usage and timing to runtime metrics",
	async (provider) => {
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(
			() => (now += 1000),
		);
		try {
			const fetchImpl = Object.assign(
				async () => {
					let events: unknown[];
					if (transports[provider] === "anthropic") {
						events = [
							{
								type: "message_start",
								message: {
									id: "msg-1",
									type: "message",
									role: "assistant",
									model: "claude-sonnet-5-5",
									content: [],
									stop_reason: null,
									stop_sequence: null,
									usage: { input_tokens: 10, output_tokens: 0 },
								},
							},
							{
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "thinking",
									thinking: "",
									signature: "",
								},
							},
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "thinking_delta", thinking: "plan" },
							},
							{ type: "content_block_stop", index: 0 },
							{
								type: "content_block_start",
								index: 1,
								content_block: { type: "text", text: "" },
							},
							{
								type: "content_block_delta",
								index: 1,
								delta: { type: "text_delta", text: "done" },
							},
							{ type: "content_block_stop", index: 1 },
							{
								type: "message_delta",
								delta: { stop_reason: "end_turn", stop_sequence: null },
								usage: { output_tokens: 100 },
							},
							{ type: "message_stop" },
						];
					} else if (transports[provider] === "chat") {
						events = [
							{
								id: "chat-1",
								model: "fixture",
								choices: [{ delta: { role: "assistant", content: "" } }],
							},
							{
								id: "chat-1",
								model: "fixture",
								choices: [{ delta: { reasoning_content: "plan" } }],
							},
							{
								id: "chat-1",
								model: "fixture",
								choices: [
									{ delta: { content: "done" }, finish_reason: "stop" },
								],
								usage: {
									prompt_tokens: 10,
									completion_tokens: 100,
									total_tokens: 110,
								},
							},
						];
					} else {
						const message = {
							id: "msg-1",
							type: "message",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "done", annotations: [] }],
						};
						const response = {
							id: "resp-1",
							object: "response",
							created_at: 0,
							model: "fixture",
							status: "completed",
							output: [message],
							usage: {
								input_tokens: 10,
								output_tokens: 100,
								total_tokens: 110,
								output_tokens_details: { reasoning_tokens: 50 },
							},
						};
						events = [
							{
								type: "response.created",
								response: { ...response, status: "in_progress", output: [] },
							},
							{
								type: "response.output_item.added",
								output_index: 0,
								item: { id: "reason-1", type: "reasoning", summary: [] },
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: { id: "reason-1", type: "reasoning", summary: [] },
							},
							{
								type: "response.output_item.added",
								output_index: 1,
								item: { ...message, content: [], status: "in_progress" },
							},
							{
								type: "response.content_part.added",
								item_id: "msg-1",
								output_index: 1,
								content_index: 0,
								part: { type: "output_text", text: "", annotations: [] },
							},
							{
								type: "response.output_text.delta",
								item_id: "msg-1",
								output_index: 1,
								content_index: 0,
								delta: "done",
							},
							{
								type: "response.output_item.done",
								output_index: 1,
								item: message,
							},
							{ type: "response.completed", response },
						];
					}
					const sse = events
						.map(
							(event) =>
								`${provider === "anthropic" ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
						)
						.join("");
					return new Response(`${sse}data: [DONE]\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				},
				{ preconnect: fetch.preconnect },
			);
			const clientOptions = { apiKey: "fixture", fetch: fetchImpl };
			let chat: BaseChatModel;
			switch (provider) {
				case "openai":
					chat = new ChatOpenAI({ clientOptions, websocketMode: "off" });
					break;
				case "openrouter":
					chat = new ChatOpenRouter({ clientOptions, model: "fixture" });
					break;
				case "xai":
					chat = new ChatXai({ clientOptions });
					break;
				case "deepseek":
					chat = new ChatDeepSeek(clientOptions);
					break;
				case "responses":
					chat = new ChatResponses({
						...clientOptions,
						provider: "fixture",
						model: "fixture",
						endpoint: {
							type: "responses",
							base_url: "https://fixture.test/v1",
							retry: "off",
							models: { fixture: { context_window: 10000 } },
						},
					});
					break;
				case "anthropic":
					chat = new ChatAnthropic({
						clientOptions,
						model: "claude-sonnet-5-5",
					});
					break;
				case "moonshot":
					chat = new ChatMoonshot(clientOptions);
					break;
				case "zai":
					chat = new ChatZai(clientOptions);
					break;
			}
			const output = await chat.ainvoke({
				messages: [{ role: "user", content: "hello" }],
			});
			expect(output.usage?.output_tokens).toBe(100);
			expect(output.timing?.generation_duration_ms).toBeGreaterThanOrEqual(250);
			const metrics = buildRunMetrics({
				type: "llm.response",
				run_id: "fixture",
				seq: 1,
				ts: "2026-11-15T00:00:00Z",
				output,
			});
			expect(metrics.output_tokens_per_second).toBeGreaterThan(0);
		} finally {
			clock.mockRestore();
		}
	},
);
