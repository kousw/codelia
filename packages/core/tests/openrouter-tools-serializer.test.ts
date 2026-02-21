import { describe, expect, test } from "bun:test";
import {
	toChatInvokeCompletion,
	toResponsesTools,
} from "../src/llm/openrouter/serializer";
import type { FunctionToolDefinition } from "../src/types/llm/tools";

describe("openrouter serializer", () => {
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

	test("maps hosted search tool to web_search for openrouter", () => {
		const tools = toResponsesTools([
			{
				type: "hosted_search",
				name: "web_search",
				provider: "openrouter",
				search_context_size: "high",
				allowed_domains: ["example.com"],
			},
		]);
		expect(tools).toHaveLength(1);
		const mapped = tools?.[0];
		if (!mapped || mapped.type !== "web_search") {
			throw new Error("expected web_search tool");
		}
		expect(mapped.search_context_size).toBe("high");
		expect(mapped.filters?.allowed_domains).toEqual(["example.com"]);
	});

	test("summarizes web_search_call as reasoning message", () => {
		const completion = toChatInvokeCompletion({
			id: "resp_123",
			model: "openai/gpt-5",
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
	});

	test("tags unknown output items as openrouter provider parts", () => {
		const completion = toChatInvokeCompletion({
			id: "resp_456",
			model: "openai/gpt-5",
			output_text: "",
			status: "completed",
			output: [
				{
					type: "response_moderation",
					id: "mod_1",
					result: "ok",
				},
			],
		} as never);
		expect(completion.messages).toHaveLength(1);
		const message = completion.messages[0];
		expect(message?.role).toBe("assistant");
		if (
			!message ||
			message.role !== "assistant" ||
			!Array.isArray(message.content)
		) {
			throw new Error("expected assistant content parts");
		}
		const first = message.content[0];
		expect(first).toMatchObject({
			type: "other",
			provider: "openrouter",
			kind: "response_moderation",
		});
	});
});
