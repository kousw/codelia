import { expect, spyOn, test } from "bun:test";
import { ChatGoogle } from "@codelia/core";
import type { GoogleGenAI } from "@google/genai";
import { buildRunMetrics } from "../src/rpc/run-metrics";

test.each([
	"text",
	"tool",
	"snapshot",
	"tool-snapshot",
	"thought-snapshot",
	"missing-thought",
] as const)(
	"Google %s completion carries provider usage and observed timing through runtime TPS",
	async (kind) => {
		const tool = kind === "tool" || kind === "tool-snapshot";
		const snapshot = kind === "snapshot" || kind === "tool-snapshot";
		let now = 0;
		const clock = spyOn(performance, "now").mockImplementation(() => now);
		try {
			const client = {
				interactions: {
					async create() {
						// Request setup/headers must remain part of first-output latency.
						now = 4000;
						return (async function* () {
							yield { event_type: "interaction.created" };
							now = 5000;
							if (kind !== "missing-thought") {
								yield {
									event_type: "step.start",
									index: 0,
									step: {
										type: "thought",
										summary:
											kind === "thought-snapshot"
												? [{ type: "text", text: "plan" }]
												: [],
										signature: "",
									},
								};
								now = 7000;
								yield {
									event_type: "step.delta",
									index: 0,
									delta: {
										type: "thought_signature",
										signature: "fixture-signature",
									},
								};
								yield { event_type: "step.stop", index: 0 };
							}
							const index = kind === "missing-thought" ? 0 : 1;
							now = snapshot ? 8000 : 7500;
							yield {
								event_type: "step.start",
								index,
								step: tool
									? {
											type: "function_call",
											id: "call-1",
											name: "echo",
											arguments: snapshot ? { text: "done" } : {},
										}
									: {
											type: "model_output",
											content: snapshot ? [{ type: "text", text: "done" }] : [],
										},
							};
							now = 8000;
							if (!snapshot)
								yield {
									event_type: "step.delta",
									index,
									delta: tool
										? {
												type: "arguments_delta",
												arguments: '{"text":"done"}',
											}
										: { type: "text", text: "done" },
								};
							yield { event_type: "step.stop", index };
							now = 9000;
							yield {
								event_type: "interaction.completed",
								interaction: {
									status: tool ? "requires_action" : "completed",
									usage: {
										total_input_tokens: 10,
										total_output_tokens: 100,
										total_thought_tokens: 100,
										total_tokens: 210,
									},
								},
							};
							now = 20_000;
						})();
					},
				},
			} as unknown as GoogleGenAI;
			const output = await new ChatGoogle({
				apiKey: "fixture",
				client,
			}).ainvoke({
				messages: [{ role: "user", content: "hello" }],
			});
			expect(output.usage).toMatchObject({
				output_tokens: 200,
				output_reasoning_tokens: 100,
			});
			expect(output.timing?.time_to_first_token_ms).toBe(
				kind === "thought-snapshot" ? 5000 : 8000,
			);
			const metrics = buildRunMetrics({
				type: "llm.response",
				run_id: "run-1",
				seq: 1,
				ts: "2026-11-15T00:00:00Z",
				output,
			});
			if (kind === "missing-thought") {
				expect(metrics.output_tokens_per_second).toBeNull();
			} else {
				expect(output.timing).toMatchObject({
					generation_start_ms: 5000,
					generation_start_source: "thought_step",
					generation_duration_ms: 4000,
				});
				expect(metrics.output_tokens_per_second).toBe(50);
			}
		} finally {
			clock.mockRestore();
		}
	},
);
