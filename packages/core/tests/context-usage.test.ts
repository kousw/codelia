import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../src/agent/agent";
import type { BaseChatModel, ChatInvokeInput } from "../src/llm/base";
import { createModelRegistry } from "../src/models/registry";
import { defineTool } from "../src/tools/define";
import type { ChatInvokeCompletion } from "../src/types/llm/invoke";

// Large opaque payload: dimensions fall back, and bytes must never count as text.
const IMAGE_URL = `data:image/png;base64,${"A".repeat(60_000)}`;

// Message-history provider: tool calls/results stay as plain messages.
class ScriptedModel implements BaseChatModel {
	readonly provider = "anthropic" as const;
	readonly model = "mock";
	readonly inputs: ChatInvokeInput[] = [];
	constructor(private readonly script: ChatInvokeCompletion[]) {}
	async ainvoke(input: ChatInvokeInput): Promise<ChatInvokeCompletion> {
		this.inputs.push(input);
		const next = this.script.shift();
		if (!next) throw new Error("script exhausted");
		return next;
	}
}

const registry = createModelRegistry([
	{
		id: "mock",
		provider: "anthropic",
		contextWindow: 4000,
		maxInputTokens: 2000,
	},
]);

const echo = defineTool({
	name: "echo",
	description: "Echo text back.",
	input: z.object({ text: z.string() }),
	execute: async ({ text }) => text.repeat(20),
});

const tokensOf = (agent: Agent, category: string): number =>
	agent.getContextUsage().breakdown.find((entry) => entry.category === category)
		?.tokens ?? -1;

describe("Agent.getContextUsage", () => {
	test("reports no provider basis before any model call", () => {
		const agent = new Agent({
			llm: new ScriptedModel([]),
			tools: [echo],
			modelRegistry: registry,
			systemPrompt: "You are a careful assistant.",
		});
		const usage = agent.getContextUsage();
		expect(usage).toMatchObject({
			provider: "anthropic",
			model: "mock",
			limit_tokens: 2000,
			used_tokens: null,
			input_tokens: null,
			left_percent: null,
			basis: "none",
		});
		expect(usage.breakdown.map((entry) => entry.category)).toEqual([
			"system",
			"tools",
			"messages",
			"tool_results",
			"images",
		]);
		// The pending system prompt and tool definitions are counted before a run.
		expect(tokensOf(agent, "system")).toBeGreaterThan(0);
		expect(tokensOf(agent, "tools")).toBeGreaterThan(0);
		expect(tokensOf(agent, "messages")).toBe(0);
		expect(tokensOf(agent, "tool_results")).toBe(0);
	});

	test("uses provider usage for used/left and estimates each category of the history", async () => {
		const llm = new ScriptedModel([
			{
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call-1",
								type: "function",
								function: { name: "echo", arguments: '{"text":"abc"}' },
							},
						],
					},
				],
				usage: {
					model: "mock",
					input_tokens: 300,
					output_tokens: 20,
					total_tokens: 320,
				},
			},
			{
				messages: [{ role: "assistant", content: "done" }],
				usage: {
					model: "mock",
					input_tokens: 900,
					output_tokens: 100,
					total_tokens: 1000,
				},
			},
		]);
		const agent = new Agent({
			llm,
			tools: [echo],
			modelRegistry: registry,
			systemPrompt: "You are a careful assistant.",
			// The image estimate exceeds this tiny limit; keep the history intact.
			compaction: null,
		});
		await agent.run([
			{ type: "text", text: "Describe this image and call echo." },
			{ type: "image_url", image_url: { url: IMAGE_URL } },
		]);
		const usage = agent.getContextUsage();
		expect(usage).toMatchObject({
			limit_tokens: 2000,
			used_tokens: 1000,
			input_tokens: 900,
			left_percent: 50,
			basis: "provider",
		});
		expect(tokensOf(agent, "messages")).toBeGreaterThan(0);
		expect(tokensOf(agent, "tool_results")).toBeGreaterThan(0);
		const images = usage.breakdown.find((entry) => entry.category === "images");
		expect(images?.count).toBe(1);
		expect(images?.tokens).toBeGreaterThan(0);
		// The image payload is never counted as text.
		expect(tokensOf(agent, "messages")).toBeLessThan(1_000);
		expect(agent.getLastUsage()?.total_tokens).toBe(1000);
	});
});
