import type { ImageMediaType } from "@codelia/shared-types";
import { imageSize } from "image-size";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE } from "./image-png";

/** Bounded header validation; attachment originals are not decoded or re-encoded. */
export function validateImageAttachment(
	bytes: Buffer,
	mediaType: ImageMediaType,
) {
	const signatures: Record<ImageMediaType, boolean> = {
		"image/png": bytes
			.subarray(0, 8)
			.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
		"image/jpeg": bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
		"image/webp":
			bytes.toString("ascii", 0, 4) === "RIFF" &&
			bytes.toString("ascii", 8, 12) === "WEBP",
		"image/gif": ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)),
	};
	if (!bytes.length || bytes.length > IMAGE_MAX_BYTES || !signatures[mediaType])
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
