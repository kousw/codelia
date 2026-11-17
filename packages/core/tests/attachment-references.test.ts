import { expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import { toAnthropicMessages } from "../src/llm/anthropic/serializer";
import { toResponsesInput } from "../src/llm/openai/serializer";
import type { AttachmentRefPart, BaseMessage } from "../src/types/llm";

test("resumed attachment references keep their place in provider input", async () => {
	const file: AttachmentRefPart = {
		type: "attachment_ref",
		attachment_ref: {
			attachment_id: "codelia-attachment-file",
			sha256: "a".repeat(64),
			byte_size: 256,
			media_type: "text/plain",
			display_name: 'Notes </user> "日本語".txt',
		},
	};
	const image = {
		type: "attachment_ref",
		attachment_ref: {
			attachment_id: "codelia-attachment-image",
			sha256: "b".repeat(64),
			byte_size: 120,
			media_type: "image/png",
			display_name: "photo.png",
		},
		image_ref: {
			artifact_id: "codelia-image-00000000-0000-0000-0000-000000000001",
			sha256: "b".repeat(64),
			byte_size: 120,
			media_type: "image/png",
			width: 2,
			height: 2,
		},
	} satisfies AttachmentRefPart;
	const history: BaseMessage[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "before-files" },
				file,
				{ type: "text", text: "between-files" },
				image,
			],
		},
		{ role: "assistant", content: "Previous answer." },
	];
	const requests: string[] = [];
	const agent = new Agent({
		llm: {
			provider: "openai",
			model: "fixture",
			ainvoke: async ({ messages }) => {
				requests.push(
					JSON.stringify(toResponsesInput(messages)),
					JSON.stringify(toAnthropicMessages(messages).messages),
				);
				return { messages: [{ role: "assistant", content: "done" }] };
			},
		},
		tools: [],
		compaction: null,
		services: {
			resolveImage: async () => {
				throw new Error("Copied images must use the attachment store");
			},
			resolveAttachmentImage: async (ref) => {
				expect(ref).toEqual(image.image_ref);
				return {
					type: "image_url",
					image_url: { url: "data:image/png;base64,YQ==" },
				};
			},
		},
	});
	agent.replaceHistoryMessages(JSON.parse(JSON.stringify(history)));
	await agent.run("Continue.");

	for (const request of requests) {
		const order = [
			"before-files",
			"codelia-attachment-file",
			"between-files",
			"photo.png",
			"YQ==",
			"Continue.",
		].map((value) => request.indexOf(value));
		expect(order.every((offset) => offset >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(request).toContain("attachment_read");
		expect(request).not.toContain("</user>");
		expect(request).not.toContain('"type":"attachment_ref"');
	}
	expect(requests).toHaveLength(2);
	expect(agent.getHistoryMessages().slice(0, 2)).toEqual(history);
});
