import { z } from "zod";
import { wireInt } from "./wire";

/** Persistence/schema safety ceiling, not a provider capability promise. */
export const IMAGE_REFERENCE_MAX_COUNT = 16;

export const ImageMediaTypeSchema = z
	.enum(["image/png", "image/jpeg", "image/webp", "image/gif"])
	.meta({ id: "ImageMediaType" });
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

/** Fixed model input representation; absent means the immutable original. */
export const ImageModelViewSchema = z
	.object({
		version: z.literal("jpeg-q90-444-v1"),
		media_type: z.literal("image/jpeg"),
		sha256: z.string(),
		byte_size: wireInt(),
	})
	.meta({
		id: "ImageModelView",
		description:
			"Fixed model input representation; absent means the immutable original.",
	});
export type ImageModelView = z.infer<typeof ImageModelViewSchema>;

export function isImageModelView(value: unknown): value is ImageModelView {
	if (!value || typeof value !== "object") return false;
	const view = value as Record<string, unknown>;
	return (
		view.version === "jpeg-q90-444-v1" &&
		view.media_type === "image/jpeg" &&
		typeof view.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(view.sha256) &&
		typeof view.byte_size === "number" &&
		Number.isSafeInteger(view.byte_size) &&
		view.byte_size > 0 &&
		view.byte_size <= 32 * 1024 * 1024
	);
}

/** Durable image identity. Bytes are resolved only at the request/preview boundary. */
export const ImageArtifactRefSchema = z
	.object({
		artifact_id: z.string(),
		sha256: z.string(),
		media_type: ImageMediaTypeSchema,
		byte_size: wireInt(),
		width: wireInt(),
		height: wireInt(),
		model_view: ImageModelViewSchema.optional(),
	})
	.meta({
		id: "ImageArtifactRef",
		description:
			"Durable image identity. Bytes are resolved only at the request/preview boundary.",
	});
export type ImageArtifactRef = z.infer<typeof ImageArtifactRefSchema>;
export type GeneratedImageMetadata = ImageArtifactRef & {
	kind?: "generated";
	media_type: "image/png" | "image/jpeg";
	created_at: string;
	provider: string;
	requested_model: string;
	effective_model?: string;
	endpoint: string;
	parent_artifact_ids: string[];
	usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
};

export type AttachedImageMetadata = ImageArtifactRef & {
	kind: "attachment";
	created_at: string;
};

export type ImageArtifactMetadata =
	| GeneratedImageMetadata
	| AttachedImageMetadata;
