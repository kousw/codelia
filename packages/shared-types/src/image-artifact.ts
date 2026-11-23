import { z } from "zod";
import { tagged, wireInt } from "./wire";

/** Persistence/schema safety ceiling, not a provider capability promise. */
export const IMAGE_REFERENCE_MAX_COUNT = 16;

export const ImageMediaTypeSchema = z
	.enum(["image/png", "image/jpeg", "image/webp", "image/gif"])
	.meta({ id: "ImageMediaType" });
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

/** Fixed model input representation; absent means the immutable original. */
export const ImageModelViewSchema = z
	.object({
		// Single-value enums: later views may add values that older receivers
		// must keep as unknown rather than reject.
		version: z.enum(["jpeg-q90-444-v1"]),
		media_type: z.enum(["image/jpeg"]),
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
export const ImageGenerationUsageSchema = z
	.object({
		input_tokens: wireInt().optional(),
		output_tokens: wireInt().optional(),
		cost_usd: z.number().optional(),
	})
	.meta({ id: "ImageGenerationUsage" });

/** A generated image. Metadata written before `kind` existed omits it. */
export const GeneratedImageMetadataSchema = ImageArtifactRefSchema.extend({
	kind: z.literal("generated").optional(),
	media_type: z.enum(["image/png", "image/jpeg"]),
	/** ISO 8601 timestamp. */
	created_at: z.string(),
	provider: z.string(),
	requested_model: z.string(),
	effective_model: z.string().optional(),
	endpoint: z.string(),
	parent_artifact_ids: z.array(z.string()),
	usage: ImageGenerationUsageSchema.optional(),
}).meta({ id: "GeneratedImageMetadata" });
export type GeneratedImageMetadata = z.infer<
	typeof GeneratedImageMetadataSchema
>;

export const AttachedImageMetadataSchema = ImageArtifactRefSchema.extend({
	kind: z.literal("attachment"),
	/** ISO 8601 timestamp. */
	created_at: z.string(),
}).meta({ id: "AttachedImageMetadata" });
export type AttachedImageMetadata = z.infer<typeof AttachedImageMetadataSchema>;

export const ImageArtifactMetadataSchema = tagged(
	"kind",
	[GeneratedImageMetadataSchema, AttachedImageMetadataSchema],
	{ id: "ImageArtifactMetadata" },
);
export type ImageArtifactMetadata = z.infer<typeof ImageArtifactMetadataSchema>;
