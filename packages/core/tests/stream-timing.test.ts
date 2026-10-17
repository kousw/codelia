import { describe, expect, test } from "bun:test";
import { LlmStreamTiming } from "../src/llm/stream-timing";

describe("observed generation timing", () => {
	test("hidden reasoning generation precedes visible deltas without counting initial wait", () => {
		let now = 0;
		const timing = new LlmStreamTiming(() => now);
		now = 500;
		timing.observeResponsesEvent({ type: "response.created" });
		timing.observeResponsesEvent({
			type: "response.output_item.added",
			item: { type: "message", content: [] },
		});
		now = 1000;
		timing.observeResponsesEvent({
			type: "response.output_item.added",
			item: { type: "reasoning", summary: [] },
		});
		now = 18000;
		timing.observeResponsesEvent({
			type: "response.output_item.added",
			item: { type: "reasoning", summary: [] },
		});
		timing.observeResponsesEvent({ type: "response.metadata" });
		now = 18771;
		timing.observeResponsesEvent({
			type: "response.function_call_arguments.delta",
			delta: "{}",
		});
		now = 18980;
		timing.observeResponsesEvent({ type: "response.completed" });
		expect(timing.finish()).toEqual({
			time_to_first_token_ms: 18771,
			generation_duration_ms: 17980,
			generation_start_ms: 1000,
			generation_start_source: "reasoning_item",
		});
	});
	test("excludes initial wait and stops at terminal arrival, before SDK/debug work", () => {
		let now = 0;
		const timing = new LlmStreamTiming(() => now);
		now = 10_000;
		timing.observeResponsesEvent({ type: "response.created" });
		timing.observeResponsesEvent({
			type: "response.output_text.delta",
			delta: "",
		});
		now = 12_000;
		timing.observeResponsesEvent({
			type: "response.output_text.delta",
			delta: "hello",
		});
		now = 14_000;
		timing.observeResponsesEvent({ type: "response.completed" });
		now = 20_000;
		expect(timing.finish()).toEqual({
			time_to_first_token_ms: 12_000,
			generation_duration_ms: 2_000,
		});
	});

	test.each([
		{ type: "response.reasoning_text.delta", delta: "think" },
		{ type: "response.reasoning_summary_text.delta", delta: "think" },
		{ type: "response.function_call_arguments.delta", delta: "{" },
		{ type: "response.refusal.delta", delta: "no" },
	])(
		"counts output deltas, including reasoning and tool-only responses: %j",
		(event) => {
			let now = 0;
			const timing = new LlmStreamTiming(() => now);
			now = 100;
			timing.observeResponsesEvent(event);
			now = 300;
			expect(timing.finish()?.generation_duration_ms).toBe(200);
		},
	);

	test("Chat Completions ignores role/usage chunks and observes reasoning/tool args", () => {
		let now = 0;
		const timing = new LlmStreamTiming(() => now);
		now = 100;
		timing.observeChatChunk({
			choices: [{ delta: { role: "assistant", content: "" } }],
		});
		now = 400;
		timing.observeChatChunk({
			choices: [{ delta: { reasoning_content: "think" } }],
		});
		now = 800;
		timing.observeChatChunk({
			choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }],
		});
		timing.observeChatChunk({ choices: [], usage: { completion_tokens: 100 } });
		expect(timing.finish()).toEqual({
			time_to_first_token_ms: 400,
			generation_duration_ms: 400,
		});
	});

	test("Anthropic thinking/tool deltas exclude initial wait and signature events", () => {
		let now = 0;
		const timing = new LlmStreamTiming(() => now);
		now = 100;
		timing.observeAnthropicEvent({
			type: "content_block_delta",
			delta: { signature: "opaque" },
		});
		now = 500;
		timing.observeAnthropicEvent({
			type: "content_block_delta",
			delta: { thinking: "think" },
		});
		now = 600;
		timing.observeAnthropicEvent({
			type: "content_block_delta",
			delta: { partial_json: "{}" },
		});
		now = 900;
		timing.observeAnthropicEvent({ type: "message_stop" });
		now = 2000;
		expect(timing.finish()).toEqual({
			time_to_first_token_ms: 500,
			generation_duration_ms: 400,
		});
	});

	test("no-output, failed-attempt and invalid clocks never invent generation timing", () => {
		let now = 0;
		const failed = new LlmStreamTiming(() => now);
		now = 100;
		failed.observeOutput();
		now = 1000;
		const successful = new LlmStreamTiming(() => now);
		now = 5000;
		successful.observeOutput();
		now = 6000;
		expect(successful.finish()).toEqual({
			time_to_first_token_ms: 4000,
			generation_duration_ms: 1000,
		});
		expect(new LlmStreamTiming(() => 0).finish()).toBeUndefined();
		const invalid = new LlmStreamTiming(() => now);
		invalid.observeOutput();
		now = -1;
		expect(invalid.finish()).toBeUndefined();
	});
});
