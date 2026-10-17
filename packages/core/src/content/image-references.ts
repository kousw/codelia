import type {
	BaseMessage,
	ContentPart,
	ImageRefPart,
	UserMessage,
} from "../types/llm";

const REGISTRY = "[codelia.image.artifacts]";
export function isImageRegistry(message: BaseMessage): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content[0]?.type === "text" &&
		message.content[0].text.startsWith(REGISTRY)
	);
}
export function imageReferenceRegistry(
	messages: BaseMessage[],
): UserMessage | null {
	const refs = new Map<string, ImageRefPart>();
	for (const message of messages) {
		if (!("content" in message) || !Array.isArray(message.content)) continue;
		for (const part of message.content)
			if (part.type === "image_ref") {
				refs.delete(part.image_ref.artifact_id);
				refs.set(part.image_ref.artifact_id, part);
			}
	}
	const recent = [...refs.values()].slice(-16);
	return recent.length
		? {
				role: "user",
				content: [
					{
						type: "text",
						text: `${REGISTRY} Saved image references (not a new user request). Use image_inspect to revisit originals; this registry does not claim visual inspection.\n`,
					},
					...recent,
				],
			}
		: null;
}
/** Compaction is textual; reference metadata is preserved separately, never forwarded as an opaque provider URL. */
export function describeImageReferences(
	messages: BaseMessage[],
): BaseMessage[] {
	return messages.map((message) => {
		if (
			message.role === "system" ||
			message.role === "reasoning" ||
			!Array.isArray(message.content)
		)
			return message;
		const content: ContentPart[] = message.content.map((part) =>
			part.type === "image_ref"
				? {
						type: "text",
						text: `[Image artifact ${part.image_ref.artifact_id}, ${part.image_ref.width}x${part.image_ref.height}; use image_inspect to view]`,
					}
				: part,
		);
		return { ...message, content };
	});
}
