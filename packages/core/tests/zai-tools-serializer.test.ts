import { describe, expect, test } from "bun:test";
import {
	appendZaiChatCompletionChunk,
	createZaiStreamAccumulator,
	toZaiChatInvokeCompletion,
	toZaiMessages,
	toZaiToolChoice,
	toZaiTools,
} from "../src/llm/zai/serializer";
import type { BaseMessage, FunctionToolDefinition } from "../src/types/llm";

describe("zai serializer", () => {
	const baseTool: FunctionToolDefinition = {
		name: "sample_tool",
		description: "sample tool",
		parameters: {
			type: "object",
			properties: {
				value: { type: "string" },
			},
		},
	};

	test("maps function tools and ignores hosted search tools", () => {
		const tools = toZaiTools([
			baseTool,
			{
				type: "hosted_search",
				name: "web_search",
				provider: "openai",
			},
		]);
		expect(tools).toEqual([
			{
				type: "function",
				function: {
					name: "sample_tool",
					description: "sample tool",
					parameters: baseTool.parameters,
				},
			},
		]);
	});

	test("maps tool choice values", () => {
		expect(toZaiToolChoice("auto")).toBe("auto");
		expect(toZaiToolChoice("required")).toBe("required");
		expect(toZaiToolChoice("none")).toBe("none");
		expect(toZaiToolChoice("sample_tool")).toEqual({
			type: "function",
			function: { name: "sample_tool" },
		});
	});

	test("serializes assistant tool-call replay followed by tool result", () => {
		const messages: BaseMessage[] = [
			{
				role: "assistant",
				content: "I will call it.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "sample_tool",
							arguments: '{"value":"a"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				tool_name: "sample_tool",
				content: "done",
			},
		];

		expect(toZaiMessages(messages)).toEqual([
			{
				role: "assistant",
				content: "I will call it.",
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "sample_tool",
							arguments: '{"value":"a"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "call_1",
				content: "done",
			},
		]);
	});

	test("normalizes reasoning, text, tool calls, and usage from stream chunks", () => {
		const accumulator = createZaiStreamAccumulator();
		appendZaiChatCompletionChunk(accumulator, {
			id: "chatcmpl_zai_1",
			model: "glm-5.2",
			choices: [
				{
					index: 0,
					delta: {
						reasoning_content: "thinking",
						content: "Answer: ",
						tool_calls: [
							{
								index: 0,
								id: "call_zai_1",
								type: "function",
								function: { name: "sample_tool", arguments: '{"v"' },
							},
						],
					},
				},
			],
		});
		appendZaiChatCompletionChunk(accumulator, {
			model: "glm-5.2",
			choices: [
				{
					index: 0,
					delta: {
						content: "ok",
						tool_calls: [
							{
								index: 0,
								function: { arguments: ":1}" },
							},
						],
					},
					finish_reason: "tool_calls",
				},
			],
			usage: {
				prompt_tokens: 12,
				completion_tokens: 5,
				total_tokens: 17,
			},
		});

		expect(
			toZaiChatInvokeCompletion(accumulator, {
				reasoning_requested: "medium",
				reasoning_applied: "high",
				reasoning_effort: "high",
				reasoning_fallback: true,
				request_id: "req_1",
			}),
		).toEqual({
			messages: [
				expect.objectContaining({
					role: "reasoning",
					content: "thinking",
				}),
				{
					role: "assistant",
					content: "Answer: ok",
					tool_calls: [
						{
							id: "call_zai_1",
							type: "function",
							function: {
								name: "sample_tool",
								arguments: '{"v":1}',
							},
							provider_meta: expect.objectContaining({
								provider: "zai",
								index: 0,
								raw_chunk_count: 2,
							}),
						},
					],
				},
			],
			usage: {
				model: "glm-5.2",
				input_tokens: 12,
				output_tokens: 5,
				total_tokens: 17,
			},
			stop_reason: "tool_calls",
			provider_meta: {
				response_id: "chatcmpl_zai_1",
				request_id: "req_1",
				finish_reason: "tool_calls",
				reasoning_requested: "medium",
				reasoning_applied: "high",
				reasoning_effort: "high",
				reasoning_fallback: true,
			},
		});
		expect(accumulator.rawChunkCount).toBe(2);
		expect(accumulator.rawChunks).toEqual([]);
	});

	test("captures raw stream chunks only when requested for provider dumps", () => {
		const defaultAccumulator = createZaiStreamAccumulator();
		const dumpAccumulator = createZaiStreamAccumulator({
			captureRawChunks: true,
		});
		const chunk = {
			id: "chatcmpl_zai_capture",
			model: "glm-5.2",
			choices: [{ index: 0, delta: { content: "ok" } }],
		};

		appendZaiChatCompletionChunk(defaultAccumulator, chunk);
		appendZaiChatCompletionChunk(dumpAccumulator, chunk);

		expect(defaultAccumulator.rawChunkCount).toBe(1);
		expect(defaultAccumulator.rawChunks).toEqual([]);
		expect(dumpAccumulator.rawChunkCount).toBe(1);
		expect(dumpAccumulator.rawChunks).toEqual([chunk]);
	});

	test("does not persist raw stream chunks in tool call provider metadata", () => {
		const accumulator = createZaiStreamAccumulator();
		for (let index = 0; index < 10; index += 1) {
			appendZaiChatCompletionChunk(accumulator, {
				id: "chatcmpl_zai_chunks",
				model: "glm-5.2",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_zai_chunks",
									type: "function",
									function: {
										name: index === 0 ? "partial_name" : "final_name",
										arguments: index === 0 ? "{" : '"ok":true}',
									},
								},
							],
						},
					},
				],
			});
		}

		const completion = toZaiChatInvokeCompletion(accumulator);
		const message = completion.messages.find(
			(entry) => entry.role === "assistant",
		);
		if (!message || message.role !== "assistant") {
			throw new Error("expected assistant message");
		}
		const toolCall = message.tool_calls?.[0];
		expect(toolCall?.function.name).toBe("final_name");
		expect(toolCall?.provider_meta).toEqual({
			provider: "zai",
			index: 0,
			raw_chunk_count: 10,
		});
		expect(JSON.stringify(toolCall?.provider_meta)).not.toContain("tool_calls");
	});
});
