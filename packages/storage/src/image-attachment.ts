import type { ImageMediaType } from "@codelia/shared-types";
import { imageSize } from "image-size";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE } from "./image-png";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function detectImageAttachmentType(
	bytes: Buffer,
): ImageMediaType | undefined {
	if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
	if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
		return "image/jpeg";
	if (
		bytes.toString("latin1", 0, 4) === "RIFF" &&
		bytes.toString("latin1", 8, 12) === "WEBP"
	)
		return "image/webp";
	if (["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6)))
		return "image/gif";
	return undefined;
}

/** Bounded header validation; attachment originals are not decoded or re-encoded. */
export function validateImageAttachment(
	bytes: Buffer,
	mediaType: ImageMediaType,
) {
	if (
		!bytes.length ||
		bytes.length > IMAGE_MAX_BYTES ||
		detectImageAttachmentType(bytes) !== mediaType
	)
		throw new Error(
			"Invalid image attachment: MIME mismatch or exceeds 32 MiB",
		);
	try {
		const { width, height } = imageSize(bytes);
		if (
			!width ||
			!height ||
			width > IMAGE_MAX_SIDE ||
			height > IMAGE_MAX_SIDE ||
			width * height > IMAGE_MAX_PIXELS
		)
			throw new Error("dimensions");
		return { width, height };
	} catch {
		throw new Error(
			"Invalid image attachment: unreadable header or exceeds 12288px/20 MP",
		);
	}
}

export const imageOriginalFilename = (mediaType: ImageMediaType): string =>
	`original.${({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as const)[mediaType]}`;
