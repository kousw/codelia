import { describe, expect, test } from "bun:test";
import { executeToolCall } from "../src/agent/tool-execution";
import { estimateUsageCostUsd } from "../src/models/registry";
import { TokenUsageService } from "../src/services/usage/service";
import { ToolPermissionDenied } from "../src/types/permissions";
import type { Tool } from "../src/tools/tool";

describe("cost estimation and TokenUsageService", () => {
	test("estimateUsageCostUsd splits uncached input, cache read/write, output, and reasoning", () => {
		const usd = estimateUsageCostUsd(
			{
				model: "claude-opus-5",
				input_tokens: 1_000_000,
				input_cached_tokens: 500_000,
				input_cache_creation_tokens: 200_000,
				output_tokens: 200_000,
				output_reasoning_tokens: 50_000,
				total_tokens: 1_200_000,
			},
			{
				input: 10,
				cacheRead: 1,
				cacheWrite: 12.5,
				output: 30,
				reasoning: 30,
			},
		);
		// uncached: 0.3M * 10 = 3.0; cacheRead: 0.5M * 1 = 0.5; cacheWrite: 0.2M * 12.5 = 2.5; output: 0.2M * 30 = 6.0 => 12.0
		expect(usd).toBeCloseTo(12.0, 6);
		expect(
			estimateUsageCostUsd(
				{
					model: "unknown",
					input_tokens: 100,
					output_tokens: 50,
					total_tokens: 150,
				},
				undefined,
			),
		).toBeNull();
	});

	test("TokenUsageService initializes total_cost_usd to null and tracks cache/reasoning/image totals", () => {
		const svc = new TokenUsageService({ enabled: true });
		expect(svc.getUsageSummary().total_cost_usd).toBeNull();

		svc.updateUsageSummary(
			{
				model: "m1",
				input_tokens: 100,
				input_cached_tokens: 40,
				input_image_tokens: 12,
				output_tokens: 50,
				output_reasoning_tokens: 20,
				total_tokens: 150,
			},
			null,
		);
		svc.updateUsageSummary(
			{
				model: "m1",
				input_tokens: 80,
				input_cached_tokens: 0,
				output_tokens: 30,
				total_tokens: 110,
			},
			0.0025,
		);

		const summary = svc.getUsageSummary();
		expect(summary.total_calls).toBe(2);
		expect(summary.cache_hit_calls).toBe(1);
		expect(summary.cache_miss_calls).toBe(1);
		expect(summary.total_output_reasoning_tokens).toBe(20);
		expect(summary.total_input_image_tokens).toBe(12);
		expect(summary.total_cost_usd).toBeCloseTo(0.0025, 6);
		expect(summary.by_model.m1?.cache_hit_calls).toBe(1);
		expect(summary.by_model.m1?.cache_miss_calls).toBe(1);

		svc.updateUsageSummary({
			model: "m1",
			input_tokens: 50,
			output_tokens: 10,
			total_tokens: 60,
		});
		const afterUnknown = svc.getUsageSummary();
		expect(afterUnknown.cache_unknown_calls).toBe(1);
		expect(afterUnknown.cache_miss_calls).toBe(1);
		expect(afterUnknown.by_model.m1?.cache_unknown_calls).toBe(1);
	});

	test("executeToolCall splits approval_wait_ms reported via ToolContext from execDurationMs", async () => {
		const approvedTool: Tool = {
			definition: {
				name: "mock_shell",
				description: "mock",
				parameters: { type: "object", properties: {} },
			},
			name: "mock_shell",
			description: "mock",
			executeRaw: async (_raw, ctx) => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				ctx.recordApprovalWaitMs?.(25);
				await new Promise((resolve) => setTimeout(resolve, 15));
				return { type: "text", text: "ok" };
			},
		};
		const approved = await executeToolCall({
			toolCall: {
				id: "call-1",
				type: "function",
				function: { name: "mock_shell", arguments: "{}" },
			},
			tools: [approvedTool],
		});
		expect(approved.approvalWaitMs).toBe(25);
		expect(approved.execDurationMs).toBeGreaterThanOrEqual(5);
		expect(approved.execDurationMs).toBeLessThan(approved.approvalWaitMs! + 40);

		const deniedTool: Tool = {
			...approvedTool,
			name: "mock_denied",
			executeRaw: async (_raw, ctx) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				ctx.recordApprovalWaitMs?.(20);
				throw new ToolPermissionDenied({
					decision: "deny",
					reason: "user_denied",
				});
			},
		};
		const denied = await executeToolCall({
			toolCall: {
				id: "call-2",
				type: "function",
				function: { name: "mock_denied", arguments: "{}" },
			},
			tools: [deniedTool],
		});
		expect(denied.approvalWaitMs).toBe(20);
		expect(denied.execDurationMs).toBe(0);
		expect(denied.message.is_error).toBe(true);
	});
});
