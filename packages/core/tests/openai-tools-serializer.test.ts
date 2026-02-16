import { describe, expect, test } from "bun:test";
import {
	toChatInvokeCompletion,
	toResponsesTools,
} from "../src/llm/openai/serializer";
import type { FunctionToolDefinition } from "../src/types/llm/tools";

describe("toResponsesTools strict mapping", () => {
	const baseTool: Omit<FunctionToolDefinition, "strict"> = {
		name: "sample_tool",
		description: "sample tool",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string" },
			},
		},
	};

	test("defaults strict=false when tool.strict is undefined", () => {
		const tools = toResponsesTools([baseTool]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(false);
	});

	test("forwards strict=true when explicitly provided", () => {
		const tools = toResponsesTools([{ ...baseTool, strict: true }]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(true);
	});

	test("forwards strict=false when explicitly provided", () => {
		const tools = toResponsesTools([{ ...baseTool, strict: false }]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "function") {
			throw new Error("expected function tool");
		}
		expect(mapped.strict).toBe(false);
	});

	test("maps hosted search tool to web_search", () => {
		const tools = toResponsesTools([
			{
				type: "hosted_search",
				name: "web_search",
				provider: "openai",
				search_context_size: "high",
				allowed_domains: ["example.com"],
				user_location: {
					country: "US",
					timezone: "America/Los_Angeles",
				},
			},
		]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "web_search") {
			throw new Error("expected web_search tool");
		}
		expect(mapped.search_context_size).toBe("high");
		expect(mapped.filters?.allowed_domains).toEqual(["example.com"]);
		expect(mapped.user_location).toMatchObject({
			type: "approximate",
			country: "US",
			timezone: "America/Los_Angeles",
		});
	});

	test("summarizes web_search_call as reasoning message", () => {
		const completion = toChatInvokeCompletion({
			id: "resp_123",
			model: "gpt-5",
			output_text: "",
			status: "completed",
			output: [
				{
					type: "web_search_call",
					id: "ws_1",
					status: "completed",
					action: {
						type: "search",
						queries: ["latest ai news"],
						sources: [{ type: "url", url: "https://example.com" }],
					},
				},
				{
					type: "message",
					id: "msg_1",
					status: "completed",
					role: "assistant",
					content: [{ type: "output_text", text: "ok", annotations: [] }],
				},
			],
		} as never);
		expect(completion.messages).toEqual([
			expect.objectContaining({
				role: "reasoning",
			}),
			expect.objectContaining({
				role: "assistant",
				content: expect.any(Array),
			}),
		]);
		const reasoning = completion.messages[0];
		expect(reasoning?.role).toBe("reasoning");
		if (reasoning?.role !== "reasoning") {
			throw new Error("expected reasoning message");
		}
		expect(reasoning.content).toContain("WebSearch status=completed");
		expect(reasoning.content).toContain("queries=latest ai news");
		expect(reasoning.content).toContain("sources=1");
	});
});
