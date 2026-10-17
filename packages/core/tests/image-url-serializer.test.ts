import { describe, expect, test } from "bun:test";
import { toAnthropicMessages } from "../src/llm/anthropic/serializer";
import { toResponsesInput } from "../src/llm/openai/serializer";
import type { BaseMessage, ContentPart } from "../src/types/llm";

const imageToolMessages = (content: ContentPart[]): BaseMessage[] => [
	{
		role: "assistant",
		content: null,
		tool_calls: [
			{
				id: "image-call",
				type: "function",
				function: { name: "view_image", arguments: "{}" },
			},
		],
	},
	{
		role: "tool",
		tool_call_id: "image-call",
		tool_name: "view_image",
		content,
	},
];

describe("remote image serialization", () => {
	test.each([
		"https://images.example.com/render?id=42",
		"http://images.example.com/image.png",
	])("preserves %s as image input in OpenAI and Anthropic tool results", (url) => {
		const content: ContentPart[] = [
			{ type: "image_url", image_url: { url, detail: "high" } },
		];
		const messages = imageToolMessages(content);
		expect(toResponsesInput(messages)).toContainEqual({
			type: "function_call_output",
			call_id: "image-call",
			output: [{ type: "input_image", image_url: url, detail: "high" }],
		});
		expect(toAnthropicMessages(messages).messages).toContainEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "image-call",
					is_error: undefined,
					content: [{ type: "image", source: { type: "url", url } }],
				},
			],
		});
		expect(toAnthropicMessages([{ role: "user", content }]).messages).toEqual([
			{
				role: "user",
				content: [{ type: "image", source: { type: "url", url } }],
			},
		]);
	});

	test("keeps inline images and unsupported URLs on their existing Anthropic paths", () => {
		const content: ContentPart[] = [
			{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
			{ type: "image_url", image_url: { url: "file:///tmp/image.png" } },
			{ type: "image_url", image_url: { url: "not a URL" } },
		];
		expect(toAnthropicMessages([{ role: "user", content }]).messages).toEqual([
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "AA==" },
					},
					{ type: "text", text: "file:///tmp/image.png" },
					{ type: "text", text: "not a URL" },
				],
			},
		]);
	});
});
