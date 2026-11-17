import { expect, test } from "bun:test";
import {
	Agent,
	type AgentEvent,
	type BaseMessage,
	type SessionRecord,
} from "@codelia/core";
import type { ImageArtifactRef } from "@codelia/shared-types";
import type { AttachmentStore, StoredAttachment } from "@codelia/storage";
import { AttachmentTransferService } from "../src/attachments/service";
import {
	normalizeRunInput,
	resolveRunInputAttachments,
} from "../src/rpc/run-input";
import { createAttachmentReadTool } from "../src/tools/attachment-read";

const sessionId = "owner-session";
const attachmentId = "codelia-attachment-00000000-0000-0000-0000-000000000003";
const otherSessionId = "other-session";
const imageRef: ImageArtifactRef = {
	artifact_id: "codelia-image-00000000-0000-0000-0000-000000000006",
	sha256: "a".repeat(64),
	media_type: "image/png",
	byte_size: 4,
	width: 1,
	height: 1,
};

const memoryStore = (
	original: Buffer,
	image?: ImageArtifactRef,
): AttachmentStore => {
	const record: StoredAttachment = {
		ref: {
			attachment_id: attachmentId,
			sha256: "a".repeat(64),
			byte_size: original.length,
			media_type: image?.media_type ?? "text/plain",
			display_name: image ? "image.png" : "notes.txt",
		},
		...(image ? { imageRef: image } : {}),
	};
	return {
		commit: async () => {},
		lookup: async (id, owner) =>
			id === attachmentId && owner === sessionId ? record : null,
		read: async (id, owner, offset, length) => {
			if (
				id !== attachmentId ||
				owner !== sessionId ||
				offset > original.length
			)
				throw new Error("Unavailable original");
			return original.subarray(offset, offset + length);
		},
	};
};
const toolContext = {
	deps: {},
	resolve: async <T>(key: { create: () => T | Promise<T> }) => key.create(),
};

test("attachment reader returns complete UTF-8 characters, exact hex and session-bound access", async () => {
	const original = Buffer.from(`\uFEFF${"a".repeat(1019)}🍣終\r\n`);
	const service = new AttachmentTransferService(memoryStore(original));
	try {
		const tool = createAttachmentReadTool(service, () => sessionId);
		const read = (options: Record<string, string | number> = {}) =>
			tool.executeRaw(
				JSON.stringify({ attachment_id: attachmentId, ...options }),
				toolContext,
			);
		await expect(read()).resolves.toMatchObject({
			type: "json",
			value: {
				data: original.subarray(0, 1022).toString("utf8"),
				eof: false,
				next_offset: 1022,
			},
		});
		await expect(read({ offset: 1022 })).resolves.toMatchObject({
			type: "json",
			value: { data: "🍣終\r\n", eof: true },
		});
		await expect(read({ offset: 1023 })).rejects.toThrow("Retry in hex mode");
		await expect(read({ offset: 1023, mode: "hex" })).resolves.toMatchObject({
			type: "json",
			value: {
				data: original.subarray(1023).toString("hex"),
				eof: true,
			},
		});
		const other = createAttachmentReadTool(service, () => otherSessionId);
		await expect(
			other.executeRaw(
				JSON.stringify({ attachment_id: attachmentId }),
				toolContext,
			),
		).rejects.toThrow("unavailable in this conversation");
	} finally {
		service.close();
	}
});

test("reader exposes an excerpt to the model while transcript and diagnostics show the read", async () => {
	const privateExcerpt = "private-original-content";
	const service = new AttachmentTransferService(
		memoryStore(Buffer.from(privateExcerpt)),
	);
	try {
		let calls = 0;
		const agent = new Agent({
			llm: {
				provider: "openai",
				model: "fixture",
				ainvoke: async ({ messages }) => {
					if (calls++ === 0) {
						expect(JSON.stringify(messages)).not.toContain(privateExcerpt);
						return {
							messages: [
								{
									role: "assistant",
									content: null,
									tool_calls: [
										{
											id: "fixture-call",
											type: "function",
											function: {
												name: "attachment_read",
												arguments: JSON.stringify({
													attachment_id: attachmentId,
												}),
											},
										},
									],
								},
							],
						};
					}
					expect(JSON.stringify(messages)).toContain(privateExcerpt);
					return { messages: [{ role: "assistant", content: "done" }] };
				},
			},
			tools: [createAttachmentReadTool(service, () => sessionId)],
			compaction: null,
		});
		const wireInput = normalizeRunInput({
			type: "parts",
			parts: [{ type: "attachment_ref", attachment_id: attachmentId }],
		});
		const input = await resolveRunInputAttachments(wireInput, {
			service,
			sessionId,
			canReadAttachment: () => true,
			canUseVision: () => false,
			canPersistInlineImages: false,
		});
		const originalMessages: BaseMessage[] = [];
		const events: AgentEvent[] = [];
		const records: SessionRecord[] = [];
		for await (const event of agent.runStream(input, {
			session: {
				run_id: "run",
				session_id: sessionId,
				append: (record) => records.push(record),
				recordMessages: async (messages) => {
					originalMessages.push(...messages);
				},
			},
		}))
			events.push(event);
		expect(calls).toBe(2);
		expect(JSON.stringify(originalMessages[0])).toContain(attachmentId);
		expect(JSON.stringify(originalMessages[0])).not.toContain(privateExcerpt);
		expect(JSON.stringify(events)).toContain("Read an attachment excerpt.");
		expect(JSON.stringify(events)).not.toContain(privateExcerpt);
		expect(JSON.stringify(records)).not.toContain(privateExcerpt);
	} finally {
		service.close();
	}
});

test("admission rejects inaccessible file readers, unsupported vision and another session", async () => {
	const document = new AttachmentTransferService(
		memoryStore(Buffer.from("notes")),
	);
	const image = new AttachmentTransferService(
		memoryStore(Buffer.alloc(4), imageRef),
	);
	const input = normalizeRunInput({
		type: "parts",
		parts: [{ type: "attachment_ref", attachment_id: attachmentId }],
	});
	const options = {
		service: document,
		sessionId,
		canReadAttachment: () => true,
		canUseVision: () => false,
		canPersistInlineImages: false,
	};
	try {
		await expect(
			resolveRunInputAttachments(input, {
				...options,
				canReadAttachment: () => false,
			}),
		).rejects.toThrow("current model or tool policy disables this reader");
		await expect(
			resolveRunInputAttachments(input, { ...options, toolChoice: "none" }),
		).rejects.toThrow("current model or tool policy disables this reader");
		await expect(
			resolveRunInputAttachments(input, {
				...options,
				sessionId: otherSessionId,
			}),
		).rejects.toThrow("unavailable or corrupt");
		await expect(
			resolveRunInputAttachments(input, { ...options, service: image }),
		).rejects.toThrow("no verified vision input");
		await expect(
			resolveRunInputAttachments(input, {
				...options,
				service: image,
				canUseVision: () => true,
			}),
		).resolves.toEqual([
			expect.objectContaining({ type: "attachment_ref", image_ref: imageRef }),
		]);
	} finally {
		document.close();
		image.close();
	}
});
