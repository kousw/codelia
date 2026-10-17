import { describe, expect, test } from "bun:test";
import type { LlmResponseRecord } from "@codelia/core";
import { buildRunMetrics } from "../src/rpc/run-metrics";

const response = (
	tokens: number | undefined,
	duration: number | undefined,
	reasoning?: number,
): LlmResponseRecord => ({
	type: "llm.response",
	run_id: "run-1",
	seq: 2,
	ts: "2026-10-17T00:00:00Z",
	output: {
		messages: [],
		...(tokens === undefined
			? {}
			: {
					usage: {
						model: "test",
						input_tokens: 10,
						output_tokens: tokens,
						...(reasoning === undefined
							? {}
							: { output_reasoning_tokens: reasoning }),
						total_tokens: 10 + tokens,
					},
				}),
		...(duration === undefined
			? {}
			: {
					timing: {
						time_to_first_token_ms: 10_000,
						generation_duration_ms: duration,
					},
				}),
	},
});

describe("completed call TPS", () => {
	test("uses output usage over generation time, excluding initial wait", () => {
		expect(buildRunMetrics(response(100, 2000)).output_tokens_per_second).toBe(
			50,
		);
		expect(buildRunMetrics(response(0, 2000)).output_tokens_per_second).toBe(0);
	});
	test.each([
		[undefined, 2000],
		[100, undefined],
		[100, 0],
		[100, -1],
		[100, Number.NaN],
		[100, Number.POSITIVE_INFINITY],
		[-1, 2000],
		[Number.POSITIVE_INFINITY, 2000],
		[100, Number.MIN_VALUE],
		[100, 208.987],
	])(
		"missing or invalid data clears stale TPS: tokens=%s duration=%s",
		(tokens, duration) => {
			expect(
				buildRunMetrics(response(tokens, duration)).output_tokens_per_second,
			).toBeNull();
		},
	);

	test("hidden reasoning requires a matching observed reasoning interval instead of visible-only duration", () => {
		const record = response(739, 208.987, 516);
		expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
		record.output.timing = {
			time_to_first_token_ms: 18770.974,
			generation_duration_ms: 17979.961,
			generation_start_ms: 1000,
			generation_start_source: "reasoning_item",
		};
		expect(buildRunMetrics(record).output_tokens_per_second).toBeCloseTo(
			41.1013,
			3,
		);
		record.output.timing.generation_start_ms = 20000;
		expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
	});

	test("invalid reasoning counts do not turn into TPS", () => {
		for (const count of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
			const record = response(100, 2000, count);
			expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
		}
	});
});
