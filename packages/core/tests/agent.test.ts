import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../src/agent/agent";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../src/llm/base";
import { createModelRegistry } from "../src/models/registry";
import { defineTool } from "../src/tools/define";
import type { ChatInvokeCompletion } from "../src/types/llm/invoke";
import type { ToolCall } from "../src/types/llm/tools";

class MockChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock";
	private readonly script: Array<ChatInvokeCompletion | Error>;
	readonly calls: Array<{
		input: ChatInvokeInput & { options?: unknown };
		context?: ChatInvokeContext;
	}> = [];

	constructor(script: Array<ChatInvokeCompletion | Error>) {
		this.script = [...script];
	}

	async ainvoke(
		input: ChatInvokeInput & { options?: unknown },
		context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion> {
		this.calls.push({ input, context });
		const next = this.script.shift();
		if (!next) {
			throw new Error("MockChatModel: no scripted response available");
		}
		if (next instanceof Error) throw next;
		return next;
	}
}

const toolCall = (id: string, name: string, args: string): ToolCall => ({
	id,
	type: "function",
	function: { name, arguments: args },
});

const assistantResponse = (
	content: string | null,
	toolCalls: ToolCall[] = [],
): ChatInvokeCompletion => ({
	messages: [
		{
			role: "assistant",
			content,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		},
	],
});

describe("Agent", () => {
	test("run returns immediately when no tool calls are present", async () => {
		const llm = new MockChatModel([assistantResponse("hello")]);

		const agent = new Agent({ llm, tools: [] });
		const result = await agent.run("hi");

		expect(result).toBe("hello");
	});

	test("runStream yields only final response when no tool calls are present", async () => {
		const llm = new MockChatModel([assistantResponse("hello")]);

		const agent = new Agent({ llm, tools: [] });
		const events = [] as Array<{ type: string; content?: string }>;

		for await (const event of agent.runStream("hi")) {
			events.push(event as { type: string; content?: string });
		}

		const textEvent = events.find((event) => event.type === "text");
		const finalEvent = events.find((event) => event.type === "final");

		expect(textEvent).toBeUndefined();
		expect(finalEvent?.content).toBe("hello");
	});

	test("runStream passes provider-neutral session key from session_id", async () => {
		const llm = new MockChatModel([assistantResponse("hello")]);
		const agent = new Agent({ llm, tools: [] });

		for await (const _event of agent.runStream("hi", {
			session: {
				run_id: "run-1",
				session_id: "session-1",
				append: () => {},
			},
		})) {
			// drain
		}

		expect(llm.calls[0]?.context?.sessionKey).toBe("session-1");
	});

	test("runStream falls back to run_id for provider-neutral session key", async () => {
		const llm = new MockChatModel([assistantResponse("hello")]);
		const agent = new Agent({ llm, tools: [] });

		for await (const _event of agent.runStream("hi", {
			session: {
				run_id: "run-42",
				append: () => {},
			},
		})) {
			// drain
		}

		expect(llm.calls[0]?.context?.sessionKey).toBe("run-42");
	});

	test("getContextLeftPercent prefers maxInputTokens", async () => {
		const llm = new MockChatModel([
			{
				messages: [{ role: "assistant", content: "done" }],
				usage: {
					model: "mock",
					input_tokens: 90,
					output_tokens: 10,
					total_tokens: 100,
				},
			},
		]);
		const modelRegistry = createModelRegistry([
			{
				id: "mock",
				provider: "openai",
				contextWindow: 1000,
				maxInputTokens: 200,
			},
		]);
		const agent = new Agent({ llm, tools: [], modelRegistry });

		await agent.run("hi");

		expect(agent.getContextLeftPercent()).toBe(50);
	});

	test("runStream forceCompaction skips user message and finishes without llm call", async () => {
		const llm = new MockChatModel([]);
		const agent = new Agent({ llm, tools: [], compaction: null });
		const events = [] as Array<{ type: string; content?: string }>;

		for await (const event of agent.runStream("ignored", {
			forceCompaction: true,
		})) {
			events.push(event as { type: string; content?: string });
		}

		expect(events).toEqual([
			{
				type: "final",
				content: "Compaction run completed.",
			},
		]);
		expect(agent.getHistoryMessages()).toEqual([]);
	});

	test("runStream formats tool_result for content parts", async () => {
		const tool = defineTool({
			name: "echo",
			description: "returns mixed content parts",
			input: z.object({}),
			execute: () => [
				{ type: "text", text: "ok" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
			],
		});

		const llm = new MockChatModel([
			assistantResponse(null, [toolCall("call_1", "echo", "{}")]),
			assistantResponse("done"),
		]);

		const agent = new Agent({ llm, tools: [tool] });
		const events = [] as Array<{ type: string; result?: string }>;

		for await (const event of agent.runStream("hi")) {
			events.push(event as { type: string; result?: string });
		}

		const toolResult = events.find((event) => event.type === "tool_result");
		expect(toolResult?.result).toBe("ok[image]");
	});

	test("run executes tool calls before returning final content", async () => {
		let executedWith = "unset";
		const tool = defineTool({
			name: "echo",
			description: "returns a value and records args",
			input: z.object({ value: z.string() }),
			execute: (input) => {
				executedWith = input.value;
				return "tool ok";
			},
		});

		const llm = new MockChatModel([
			assistantResponse(null, [toolCall("call_1", "echo", '{"value":"x"}')]),
			assistantResponse("done"),
		]);

		const agent = new Agent({ llm, tools: [tool] });
		const result = await agent.run("hi");

		expect(executedWith).toBe("x");
		expect(result).toBe("done");
	});

	test("runStream emits tool call lifecycle events", async () => {
		const tool = defineTool({
			name: "echo",
			description: "returns a value",
			input: z.object({ value: z.string() }),
			execute: (input) => `ok:${input.value}`,
		});

		const llm = new MockChatModel([
			assistantResponse(null, [toolCall("call_1", "echo", '{"value":"x"}')]),
			assistantResponse("done"),
		]);

		const agent = new Agent({ llm, tools: [tool] });
		const events = [] as Array<{ type: string; result?: string }>;

		for await (const event of agent.runStream("hi")) {
			events.push(event as { type: string; result?: string });
		}

		const types = events.map((event) => event.type);
		expect(types).toContain("step_start");
		expect(types).toContain("tool_call");
		expect(types).toContain("tool_result");
		expect(types).toContain("step_complete");
		expect(types).toContain("final");

		const toolResult = events.find((event) => event.type === "tool_result");
		expect(toolResult?.result).toBe("ok:x");
	});

	test("runStream emits tool lifecycle for hosted web search callbacks", async () => {
		const llm = new MockChatModel([
			{
				messages: [
					{
						role: "reasoning",
						content: "WebSearch status=completed",
						raw_item: {
							type: "web_search_call",
							id: "ws_1",
							status: "completed",
							action: {
								type: "search",
								queries: ["latest ai news"],
								sources: [{ type: "url", url: "https://example.com" }],
							},
						},
					},
					{
						role: "assistant",
						content: "summary",
					},
				],
			},
		]);

		const agent = new Agent({ llm, tools: [] });
		const events = [] as Array<{
			type: string;
			tool?: string;
			result?: string;
			display_name?: string;
		}>;

		for await (const event of agent.runStream("hi")) {
			events.push(event as never);
		}

		const types = events.map((event) => event.type);
		expect(types).toContain("step_start");
		expect(types).toContain("tool_call");
		expect(types).toContain("tool_result");
		expect(types).toContain("step_complete");
		expect(types).toContain("final");
		const webSearchCall = events.find(
			(event) => event.type === "tool_call" && event.tool === "web_search",
		);
		expect(webSearchCall?.display_name).toBe("WebSearch");
		const webSearchResult = events.find(
			(event) => event.type === "tool_result" && event.tool === "web_search",
		);
		expect(webSearchResult?.result).toContain("WebSearch status=completed");
	});

	test("runStream merges hosted web search updates by callback id", async () => {
		const llm = new MockChatModel([
			{
				messages: [
					{
						role: "reasoning",
						content: "WebSearch status=in_progress",
						raw_item: {
							type: "web_search_call",
							id: "ws_1",
							status: "in_progress",
							action: {
								type: "search",
								queries: ["US manga releases today February 16 2026"],
								sources: [{ type: "url", url: "https://example.com/1" }],
							},
						},
					},
					{
						role: "reasoning",
						content: "WebSearch status=completed",
						raw_item: {
							type: "web_search_call",
							id: "ws_1",
							status: "completed",
							action: {
								type: "search",
							},
						},
					},
					{
						role: "assistant",
						content: "summary",
					},
				],
			},
		]);

		const agent = new Agent({ llm, tools: [] });
		const events = [] as Array<{
			type: string;
			tool?: string;
			result?: string;
			args?: Record<string, unknown>;
		}>;

		for await (const event of agent.runStream("hi")) {
			events.push(event as never);
		}

		const webSearchCalls = events.filter(
			(event) => event.type === "tool_call" && event.tool === "web_search",
		);
		const webSearchResults = events.filter(
			(event) => event.type === "tool_result" && event.tool === "web_search",
		);

		expect(webSearchCalls).toHaveLength(1);
		expect(webSearchResults).toHaveLength(1);
		expect(webSearchCalls[0]?.args).toMatchObject({
			status: "completed",
			queries: ["US manga releases today February 16 2026"],
		});
		expect(webSearchResults[0]?.result).toContain(
			"queries=US manga releases today February 16 2026",
		);
	});

	test("run returns fallback when max-iterations summary fails", async () => {
		const llm = new MockChatModel([
			assistantResponse(null),
			new Error("summary failed"),
		]);

		const agent = new Agent({
			llm,
			tools: [],
			maxIterations: 1,
			requireDoneTool: true,
		});

		const result = await agent.run("hi");
		expect(result).toBe(
			"[Max Iterations Reached]\n\nSummary unavailable due to an internal error.",
		);
	});

	test("run returns summary after max-iterations when requireDoneTool is true", async () => {
		const llm = new MockChatModel([
			assistantResponse("not done"),
			assistantResponse("still running"),
			assistantResponse("summary content"),
		]);

		const agent = new Agent({
			llm,
			tools: [],
			maxIterations: 2,
			requireDoneTool: true,
		});

		const result = await agent.run("hi");
		expect(result).toBe("[Max Iterations Reached]\n\nsummary content");
	});

	test("run stops turn when tool permission deny requests stop_turn", async () => {
		let executed = false;
		const tool = defineTool({
			name: "echo",
			description: "returns a value",
			input: z.object({ value: z.string() }),
			execute: (input) => {
				executed = true;
				return `ok:${input.value}`;
			},
		});

		const llm = new MockChatModel([
			assistantResponse(null, [toolCall("call_1", "echo", '{"value":"x"}')]),
		]);

		const agent = new Agent({
			llm,
			tools: [tool],
			canExecuteTool: async () => ({
				decision: "deny",
				reason: "user denied",
				stop_turn: true,
			}),
		});

		const result = await agent.run("hi");
		expect(executed).toBe(false);
		expect(result).toContain("Turn stopped");
	});

	test("run continues when tool permission deny does not request stop_turn", async () => {
		let executed = false;
		const tool = defineTool({
			name: "echo",
			description: "returns a value",
			input: z.object({ value: z.string() }),
			execute: (input) => {
				executed = true;
				return `ok:${input.value}`;
			},
		});

		const llm = new MockChatModel([
			assistantResponse(null, [toolCall("call_1", "echo", '{"value":"x"}')]),
			assistantResponse("continued"),
		]);

		const agent = new Agent({
			llm,
			tools: [tool],
			canExecuteTool: async () => ({
				decision: "deny",
				reason: "blocked by rule",
			}),
		});

		const result = await agent.run("hi");
		expect(executed).toBe(false);
		expect(result).toBe("continued");
	});
});
