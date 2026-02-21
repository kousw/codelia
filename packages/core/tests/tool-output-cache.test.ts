import { describe, expect, test } from "bun:test";
import { ToolOutputCacheService } from "../src/services/tool-output-cache/service";
import type { ToolOutputCacheStore } from "../src/services/tool-output-cache/store";
import type { ToolMessage } from "../src/types/llm/messages";
import type { BaseChatModel } from "../src/llm/base";

const createStore = (): ToolOutputCacheStore => ({
	save: async (record) => ({
		id: record.tool_call_id,
		byte_size: Buffer.byteLength(record.content, "utf8"),
		line_count: record.content.split(/\r?\n/).length,
	}),
	read: async () => "",
	grep: async () => "",
});

describe("ToolOutputCacheService", () => {
	test("does not truncate long single-line content when under maxMessageBytes", async () => {
		const service = new ToolOutputCacheService(
			{ maxMessageBytes: 50 * 1024 },
			{
				modelRegistry: {
					modelsById: {},
					aliasesByProvider: {
						openai: {},
						anthropic: {},
						openrouter: {},
						google: {},
					},
				},
				store: createStore(),
			},
		);
		const longSingleLine = "x".repeat(12_000);
		const message: ToolMessage = {
			role: "tool",
			tool_call_id: "call_single_line",
			tool_name: "skill_load",
			content: longSingleLine,
		};

		const processed = await service.processToolMessage(message);
		expect(processed.content).toBe(longSingleLine);
		expect(processed.trimmed).toBeFalsy();
		expect(processed.output_ref?.id).toBe("call_single_line");
	});

	test("does not immediately truncate tool_output_cache results", async () => {
		const service = new ToolOutputCacheService(
			{ maxMessageBytes: 50 * 1024 },
			{
				modelRegistry: {
					modelsById: {},
					aliasesByProvider: {
						openai: {},
						anthropic: {},
						openrouter: {},
						google: {},
					},
				},
				store: createStore(),
			},
		);
		const longSingleLine = "x".repeat(70_000);
		const message: ToolMessage = {
			role: "tool",
			tool_call_id: "call_cache_read",
			tool_name: "tool_output_cache",
			content: longSingleLine,
		};

		const processed = await service.processToolMessage(message);
		expect(processed.content).toBe(longSingleLine);
		expect(processed.content).not.toContain("[tool output truncated");
		expect(processed.trimmed).toBeFalsy();
		expect(processed.output_ref?.id).toBe("call_cache_read");
	});

	test("skips total-budget trim when totalBudgetTrim is disabled", async () => {
		const service = new ToolOutputCacheService(
			{
				contextBudgetTokens: 1,
				totalBudgetTrim: false,
			},
			{
				modelRegistry: {
					modelsById: {},
					aliasesByProvider: {
						openai: {},
						anthropic: {},
						openrouter: {},
						google: {},
					},
				},
				store: createStore(),
			},
		);
		const llm: BaseChatModel = {
			provider: "openai",
			model: "mock",
			ainvoke: async () => ({
				messages: [],
			}),
		};
		const messages = [
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "read",
				content: "this would normally be trimmed by tiny budget",
			},
		] as const;
		const result = await service.trimMessages(llm, [...messages]);
		expect(result.trimmed).toBe(false);
		expect(result.messages[0]).toMatchObject(messages[0]);
	});
});
