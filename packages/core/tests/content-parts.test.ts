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
});
