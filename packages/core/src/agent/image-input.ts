import {
	attachmentImageReference,
	describeAttachmentReference,
} from "../content/attachment-references";
import { isImageRegistry } from "../content/image-references";
import type { AgentServices } from "../di/agent-services";
import type { BaseMessage, ContentPart } from "../types/llm";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** Append-stable model input: never replace earlier images as newer ones arrive. */
export async function materializeImageReferences(
	messages: BaseMessage[],
	resolve: AgentServices["resolveImage"],
	signal?: AbortSignal,
	resolveAttachment: AgentServices["resolveAttachmentImage"] = resolve,
): Promise<BaseMessage[]> {
	signal?.throwIfAborted();
	if (resolve || resolveAttachment) {
		for (const message of messages) {
			if (isImageRegistry(message) || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				const image = attachmentImageReference(part);
				if (!image) continue;
				if (!(part.type === "attachment_ref" ? resolveAttachment : resolve))
					continue;
				const size = image.image_ref.byte_size;
				if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES)
					throw new Error(
						"Invalid or oversized image reference; model request was not sent.",
					);
			}
		}
	}
	const result: BaseMessage[] = [];
	for (const message of messages) {
		if (
			!Array.isArray(message.content) ||
			message.role === "system" ||
			message.role === "reasoning"
		) {
			result.push(message);
			continue;
		}
		const registry = isImageRegistry(message);
		const content: ContentPart[] = [];
		for (const part of message.content) {
			if (part.type === "attachment_ref") {
				content.push({ type: "text", text: describeAttachmentReference(part) });
				if (!part.image_ref) continue;
			}
			const imagePart = attachmentImageReference(part);
			if (!imagePart) {
				content.push(part);
				continue;
			}
			signal?.throwIfAborted();
			const resolvePart =
				part.type === "attachment_ref" ? resolveAttachment : resolve;
			if (!registry && resolvePart) {
				try {
					const image = await resolvePart(imagePart.image_ref, signal);
					content.push(
						imagePart.detail
							? {
									...image,
									image_url: { ...image.image_url, detail: imagePart.detail },
								}
							: image,
					);
					signal?.throwIfAborted();
					continue;
				} catch {
					signal?.throwIfAborted();
					throw new Error(
						`Image artifact ${imagePart.image_ref.artifact_id} or its fixed model view is unavailable or corrupt. Restore the saved bytes or compact the conversation; model request was not sent to avoid rewriting earlier image input.`,
					);
				}
			}
			content.push({
				type: "text",
				text: `[Image artifact ${imagePart.image_ref.artifact_id}: ${registry ? "compacted image registry; use image_inspect to revisit" : "image input unavailable on this connection"}. Not visually inspected.]`,
			});
		}
		result.push({ ...message, content });
	}
	return result;
}
