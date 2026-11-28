import { describe, expect, test } from "bun:test";
import type { LlmResponseRecord } from "@codelia/core";
import { ApprovalDispatcher } from "../src/permissions/dispatch";
import { buildCallRunMetrics, buildRunMetrics } from "../src/rpc/run-metrics";

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
		"missing or invalid data reports unavailable TPS: tokens=%s duration=%s",
		(tokens, duration) => {
			expect(
				buildRunMetrics(response(tokens, duration)).output_tokens_per_second,
			).toBeNull();
		},
	);

	test.each(["reasoning_item", "thought_step"] as const)(
		"hidden reasoning requires a matching observed %s interval instead of visible-only duration",
		(source) => {
			const record = response(739, 208.987, 516);
			expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
			record.output.timing = {
				time_to_first_token_ms: 18770.974,
				generation_duration_ms: 17979.961,
				generation_start_ms: 1000,
				generation_start_source: source,
			};
			expect(buildRunMetrics(record).output_tokens_per_second).toBeCloseTo(
				41.1013,
				3,
			);
			record.output.timing.generation_start_ms = 20000;
			expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
		},
	);

	test("invalid reasoning counts do not turn into TPS", () => {
		for (const count of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
			const record = response(100, 2000, count);
			expect(buildRunMetrics(record).output_tokens_per_second).toBeNull();
		}
	});
});

describe("buildCallRunMetrics", () => {
	test("classifies cache hit/miss/unknown, normalizes model names, resolves cost, and extracts codex server_model", () => {
		const unknownCache = buildCallRunMetrics({
			record: {
				type: "llm.response",
				run_id: "run-1",
				seq: 1,
				ts: "2026-11-28T00:00:01Z",
				output: {
					messages: [],
					usage: {
						model: "  ",
						input_tokens: 1_000_000,
						output_tokens: 100_000,
						total_tokens: 1_100_000,
					},
					provider_meta: {
						codex_metadata: { server_model: "gpt-6.2-sol-server" },
					},
				},
			},
			request: {
				ts: "2026-11-28T00:00:00Z",
				provider: "openai",
				model: "gpt-6.2-sol",
			},
			latencyMs: 912.6,
			metered: true,
			getModelCost: (name) =>
				name === "gpt-6.2-sol" ? { input: 5, output: 15 } : undefined,
			retryCount: 1,
			retryWaitMs: 300,
		});
		expect(unknownCache.model).toBe("gpt-6.2-sol");
		expect(unknownCache.actual_model).toBe("gpt-6.2-sol-server");
		expect(unknownCache.cache?.hit_state).toBe("unknown");
		expect(unknownCache.cache?.cache_read_ratio).toBeNull();
		expect(unknownCache.cost_basis).toBe("api_list");
		expect(unknownCache.cost_usd).toBeCloseTo(6.5, 6);
		expect(unknownCache.latency_ms).toBe(913);

		const missCache = buildCallRunMetrics({
			record: {
				type: "llm.response",
				run_id: "run-1",
				seq: 2,
				ts: "2026-11-28T00:00:02Z",
				output: {
					messages: [],
					usage: {
						model: "claude-opus-5-20260901",
						input_tokens: 1000,
						input_cached_tokens: 0,
						output_tokens: 100,
						total_tokens: 1100,
					},
				},
			},
			request: {
				ts: "2026-11-28T00:00:01Z",
				provider: "anthropic",
				model: "claude-opus-5",
			},
			latencyMs: 200,
			metered: false,
			getModelCost: () => ({ input: 10, output: 30 }),
			retryCount: 0,
			retryWaitMs: 0,
		});
		expect(missCache.model).toBe("claude-opus-5-20260901");
		expect(missCache.cache?.hit_state).toBe("miss");
		expect(missCache.cache?.cache_read_ratio).toBe(0);
		expect(missCache.cost_usd).toBeNull();
		expect(missCache.cost_basis).toBe("unavailable");
	});
});

describe("ApprovalDispatcher unified approval wait timing", () => {
	test("reports elapsed confirmation wait once on allow and on deny", async () => {
		let clock = 1000;
		let nextChoice: "allow_once" | "deny_continue" = "allow_once";
		const dispatcher = new ApprovalDispatcher({
			monotonicNow: () => clock,
			confirmation: {
				available: () => true,
				confirm: async (req) => {
					clock += 350;
					return { requestId: req.requestId, choice: nextChoice };
				},
			},
		});
		const baseFacts = () => ({
			valid: true,
			owned: true,
			registered: true,
			enforceable: true,
			profile: "development" as const,
			requested: [{ operation: "write" as const, target: "/repo/a.ts" }],
			ceiling: [{ operation: "write" as const, target: "/repo/a.ts" }],
			granted: [],
		});

		const allowWaits: number[] = [];
		const value = await dispatcher.dispatch({
			request: {
				id: "req-allow",
				owner: "sess-1",
				origin: "parent_agent",
				subject: "write",
				registration: "builtin/write/1",
				input: "{}",
				authorityVersion: "1",
				intentVersion: "1",
				connectionGeneration: "1",
			},
			evaluate: baseFacts,
			stillCurrent: () => true,
			preview: () => "write a.ts",
			onApprovalWaitMs: (ms) => allowWaits.push(ms),
			execute: () => {
				clock += 900; // execution time must NOT leak into approval wait
				return "done";
			},
		});
		expect(value).toBe("done");
		expect(allowWaits).toEqual([350]);

		nextChoice = "deny_continue";
		const denyWaits: number[] = [];
		await expect(
			dispatcher.dispatch({
				request: {
					id: "req-deny",
					owner: "sess-1",
					origin: "parent_agent",
					subject: "write",
					registration: "builtin/write/1",
					input: "{}",
					authorityVersion: "1",
					intentVersion: "1",
					connectionGeneration: "1",
				},
				evaluate: baseFacts,
				stillCurrent: () => true,
				preview: () => "write a.ts",
				onApprovalWaitMs: (ms) => denyWaits.push(ms),
				execute: () => "unreachable",
			}),
		).rejects.toThrow("user_denied");
		expect(denyWaits).toEqual([350]);
	});
});
