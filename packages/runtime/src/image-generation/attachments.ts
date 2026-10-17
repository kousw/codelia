import type { ContentPart } from "@codelia/core";
import type { ImageMediaType } from "@codelia/shared-types";
import type { ImageArtifactStore } from "@codelia/storage";
import { IMAGE_REFERENCE_MAX_BYTES } from "./references";

/** Import only explicitly submitted inline images; never fetch remote URLs here. */
export async function persistImageAttachments(
	input: string | ContentPart[],
	store: Pick<ImageArtifactStore, "saveAttachment">,
): Promise<string | ContentPart[]> {
	if (typeof input === "string") return input;
	const result: ContentPart[] = [];
	let imageNumber = 0;
	for (const part of input) {
		if (part.type !== "image_url") {
			result.push(part);
			continue;
		}
		imageNumber++;
		const url = part.image_url.url;
		if (!url.startsWith("data:")) {
			result.push(part);
			continue;
		}
		if (url.length > Math.ceil(IMAGE_REFERENCE_MAX_BYTES / 3) * 4 + 64)
			throw new Error("Image attachment exceeds 8 MiB");
		const match =
			/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/.exec(
				url,
			);
		if (!match)
			throw new Error(
				"Image attachment must be a PNG/JPEG/WebP/GIF base64 data URL",
			);
		const mediaType = match[1] as ImageMediaType;
		const encoded = match[2] ?? "";
		const bytes = Buffer.from(encoded, "base64");
		if (
			!encoded ||
			bytes.toString("base64") !== encoded ||
			(part.image_url.media_type && part.image_url.media_type !== mediaType)
		)
			throw new Error("Invalid image attachment encoding or MIME mismatch");
		const metadata = await store.saveAttachment(bytes, mediaType);
		const { artifact_id, sha256, media_type, byte_size, width, height } =
			metadata;
		result.push(
			{
				type: "text",
				text: `[Attached image ${imageNumber}: ${artifact_id}. To use this image as a generation reference, explicitly supply images: [{"type":"artifact","artifact_id":"${artifact_id}"}].]`,
			},
			{
				type: "image_ref",
				image_ref: {
					artifact_id,
					sha256,
					media_type,
					byte_size,
					width,
					height,
				},
				...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
			},
		);
	}
	return result;
}
