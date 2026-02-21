import { describe, expect, test } from "bun:test";
import { toAnthropicMessages } from "../src/llm/anthropic/serializer";
import { toResponseInputContent } from "../src/llm/openai/response-utils";
import { toResponsesInput } from "../src/llm/openai/serializer";
import { isContentPart } from "../src/types/llm/guards";

describe("ContentPart other", () => {
	test("isContentPart accepts provider-specific other part", () => {
		expect(
			isContentPart({
				type: "other",
				provider: "openai",
				kind: "input_text",
				payload: { type: "input_text", text: "hello" },
			}),
		).toBe(true);
	});

	test("openai response-utils forwards valid openai payload", () => {
		const part = {
			type: "other" as const,
			provider: "openai",
			kind: "input_text",
			payload: {
				type: "input_text",
				text: "from payload",
			},
		};
		const result = toResponseInputContent(part);
		expect(result).toEqual({
			type: "input_text",
			text: "from payload",
		});
	});

	test("openai response-utils degrades foreign provider payload to text", () => {
		const part = {
			type: "other" as const,
			provider: "anthropic",
			kind: "tool_result",
			payload: { foo: "bar" },
		};
		const result = toResponseInputContent(part);
		expect(result.type).toBe("input_text");
		if (result.type === "input_text") {
			expect(result.text).toContain("[other:anthropic/tool_result]");
		}
	});

	test("anthropic serializer forwards anthropic text block payload", () => {
		const { messages } = toAnthropicMessages([
			{
				role: "user",
				content: [
					{
						type: "other",
						provider: "anthropic",
						kind: "content_block",
						payload: {
							type: "text",
							text: "anthropic block",
						},
					},
				],
			},
		]);
		expect(messages).toHaveLength(1);
		const first = messages[0];
		expect(first.role).toBe("user");
		expect(first.content).toEqual([
			{
				type: "text",
				text: "anthropic block",
			},
		]);
	});

	test("openai serializer restores assistant text as output_text", () => {
		const items = toResponsesInput([
			{
				role: "assistant",
				content: "previous answer",
			},
		]);
		expect(items).toHaveLength(1);
		const first = items[0] as unknown as Record<string, unknown>;
		expect(first.type).toBe("message");
		expect(first.role).toBe("assistant");
		expect((first.content as Array<Record<string, unknown>>)[0]).toMatchObject({
			type: "output_text",
			text: "previous answer",
		});
	});

	test("openai serializer forwards assistant refusal payload", () => {
		const items = toResponsesInput([
			{
				role: "assistant",
				content: null,
				refusal: "cannot comply",
			},
		]);
		expect(items).toHaveLength(1);
		const first = items[0] as unknown as Record<string, unknown>;
		expect(first.type).toBe("message");
		expect(first.role).toBe("assistant");
		expect((first.content as Array<Record<string, unknown>>)[0]).toMatchObject({
			type: "refusal",
			refusal: "cannot comply",
		});
	});

	test("openai serializer re-injects reasoning raw item", () => {
		const raw = {
			type: "reasoning",
			id: "rs_1",
			summary: [{ type: "summary_text", text: "thinking" }],
			encrypted_content: "enc",
		};
		const items = toResponsesInput([
			{
				role: "reasoning",
				content: "thinking",
				raw_item: raw,
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject(raw);
	});

	test("openai serializer re-injects web_search_call raw item", () => {
		const raw = {
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			action: {
				type: "search",
				queries: ["latest ai news"],
				sources: [{ type: "url", url: "https://example.com" }],
			},
		};
		const items = toResponsesInput([
			{
				role: "reasoning",
				content: "WebSearch status=completed",
				raw_item: raw,
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject(raw);
	});

	test("openai serializer ignores reasoning message without replayable raw item", () => {
		const items = toResponsesInput([
			{
				role: "reasoning",
				content: "summary only",
			},
		]);
		expect(items).toEqual([]);
	});

	test("openai serializer preserves function_call id from provider_meta", () => {
		const items = toResponsesInput([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo hi"}',
						},
						provider_meta: {
							id: "fc_1",
							type: "function_call",
							status: "completed",
							call_id: "call_1",
							name: "bash",
							arguments: '{"command":"echo hi"}',
							parsed_arguments: null,
						},
					},
				],
			},
		]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "bash",
		});
	});

	test("anthropic serializer batches consecutive tool messages into one user message", () => {
		const { messages } = toAnthropicMessages([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tool_1",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 1"}',
						},
					},
					{
						id: "tool_2",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 2"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "tool_1",
				tool_name: "bash",
				content: "one",
			},
			{
				role: "tool",
				tool_call_id: "tool_2",
				tool_name: "bash",
				content: "two",
			},
		]);
		expect(messages).toHaveLength(2);
		const second = messages[1];
		expect(second.role).toBe("user");
		expect(second.content).toMatchObject([
			{ type: "tool_result", tool_use_id: "tool_1" },
			{ type: "tool_result", tool_use_id: "tool_2" },
		]);
	});

	test("anthropic serializer removes orphan tool_use blocks", () => {
		const { messages } = toAnthropicMessages([
			{
				role: "assistant",
				content: "running tools",
				tool_calls: [
					{
						id: "tool_1",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 1"}',
						},
					},
					{
						id: "tool_2",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 2"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "tool_1",
				tool_name: "bash",
				content: "only first",
			},
		]);
		expect(messages).toHaveLength(2);
		const first = messages[0];
		if (!Array.isArray(first.content)) {
			throw new Error("expected anthropic assistant blocks");
		}
		const toolUseIds = first.content
			.filter((block) => block.type === "tool_use")
			.map((block) => block.id);
		expect(toolUseIds).toEqual(["tool_1"]);
	});

	test("anthropic serializer coalesces consecutive assistant tool_use turns", () => {
		const { messages } = toAnthropicMessages([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tool_1",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 1"}',
						},
					},
				],
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "tool_2",
						type: "function",
						function: {
							name: "bash",
							arguments: '{"command":"echo 2"}',
						},
					},
				],
			},
			{
				role: "tool",
				tool_call_id: "tool_1",
				tool_name: "bash",
				content: "one",
			},
			{
				role: "tool",
				tool_call_id: "tool_2",
				tool_name: "bash",
				content: "two",
			},
		]);
		expect(messages).toHaveLength(2);
		const first = messages[0];
		expect(first.role).toBe("assistant");
		if (!Array.isArray(first.content)) {
			throw new Error("expected anthropic assistant blocks");
		}
		const toolUseIds = first.content
			.filter((block) => block.type === "tool_use")
			.map((block) => block.id);
		expect(toolUseIds).toEqual(["tool_1", "tool_2"]);
		const second = messages[1];
		expect(second.role).toBe("user");
		expect(second.content).toMatchObject([
			{ type: "tool_result", tool_use_id: "tool_1" },
			{ type: "tool_result", tool_use_id: "tool_2" },
		]);
	});
});
