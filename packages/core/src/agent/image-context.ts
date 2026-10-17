import { imageSize } from "image-size";
import { isImageRegistry } from "../content/image-references";
import type { BaseChatModel, ChatInvokeInput } from "../llm/base";
import {
	estimateImageTokens,
	type ImageTokenInput,
	imagePayloadLimit,
} from "../llm/image-policy";

export type ImageContextEstimate = {
	text_tokens: number;
	image_tokens: number;
	total_tokens: number;
	image_count: number;
	fallback_image_count: number;
	encoded_image_bytes: number;
	estimated_request_bytes: number;
};

/** Never tokenize image encodings as text, fetch URLs, or resolve stored originals. */
export function estimateImageContext(
	input: ChatInvokeInput,
	llm: BaseChatModel,
	resolveReferences = true,
): ImageContextEstimate {
	let imageTokens = 0;
	let imageCount = 0;
	let fallbackCount = 0;
	let imageBytes = 0;
	const account = (image: ImageTokenInput) => {
		const estimate =
			llm.estimateImageTokens?.(image) ??
			estimateImageTokens(llm.provider, input.model ?? llm.model, image);
		if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens < 0)
			throw new Error("Invalid model image-token estimate");
		imageTokens += estimate.tokens;
		imageCount++;
		if (estimate.method === "fallback") fallbackCount++;
	};
	const messages = input.messages.map((message) => {
		if (!Array.isArray(message.content)) return message;
		const registry = isImageRegistry(message);
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type === "image_ref") {
					if (!registry && resolveReferences) {
						account({
							width: part.image_ref.width,
							height: part.image_ref.height,
							detail: part.detail,
						});
						imageBytes +=
							4 *
								Math.ceil(
									(part.image_ref.model_view?.byte_size ??
										part.image_ref.byte_size) / 3,
								) +
							64;
					}
					return {
						type: "text",
						text: `[Image ${part.image_ref.artifact_id}]`,
					};
				}
				if (part.type === "image_url") {
					let dimensions: { width?: number; height?: number } = {};
					const url = part.image_url.url;
					const comma = url.indexOf(",");
					if (
						url.startsWith("data:image/") &&
						url.slice(0, comma).endsWith(";base64") &&
						url.length <= 12 * 1024 * 1024
					) {
						try {
							dimensions = imageSize(
								Buffer.from(url.slice(comma + 1), "base64"),
							);
						} catch {
							// Unknown dimensions use the explicit fallback; validation belongs to ingestion/provider.
							dimensions = {};
						}
					}
					account({ ...dimensions, detail: part.image_url.detail });
					imageBytes += Buffer.byteLength(part.image_url.url);
					return { type: "text", text: "[Image]" };
				}
				if (part.type === "document")
					return {
						type: "text",
						text: "[Document: token estimate unavailable]",
					};
				return part;
			}),
		};
	});
	const textBytes = Buffer.byteLength(
		JSON.stringify({
			messages,
			tools: input.tools ?? null,
			tool_choice: input.toolChoice,
		}),
	);
	const textTokens = Math.ceil(textBytes / 3);
	return {
		text_tokens: textTokens,
		image_tokens: imageTokens,
		total_tokens: textTokens + imageTokens,
		image_count: imageCount,
		fallback_image_count: fallbackCount,
		encoded_image_bytes: imageBytes,
		estimated_request_bytes: textBytes + imageBytes,
	};
}

/** Transport guard only: deliberately does not trigger conversation summarization. */
export function validateImagePayload(
	estimate: ImageContextEstimate,
	llm: BaseChatModel,
): void {
	const limit = imagePayloadLimit(llm.provider);
	if (estimate.image_count && limit && estimate.estimated_request_bytes > limit)
		throw new Error(
			`Image-bearing request exceeds the ${llm.provider} transport payload budget (${limit} bytes), not the context-token budget. Use smaller attachments in a new conversation or explicitly reorganize this history. Originals are unchanged; no model request was sent.`,
		);
}
