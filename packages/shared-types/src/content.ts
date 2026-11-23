import { z } from "zod";
import { AttachmentRefSchema } from "./attachment";
import { ImageArtifactRefSchema, ImageMediaTypeSchema } from "./image-artifact";
import { tagged } from "./wire";

/**
 * Message Content Parts
 */
export const ImageDetailSchema = z
	.enum(["auto", "low", "high"])
	.meta({ id: "ImageDetail" });

export const ImageRefPartSchema = z
	.object({
		type: z.literal("image_ref"),
		image_ref: ImageArtifactRefSchema,
		detail: ImageDetailSchema.optional(),
	})
	.meta({ id: "ImageRefPart" });
export type ImageRefPart = z.infer<typeof ImageRefPartSchema>;

export const AttachmentRefPartSchema = z
	.object({
		type: z.literal("attachment_ref"),
		attachment_ref: AttachmentRefSchema,
		image_ref: ImageArtifactRefSchema.optional(),
	})
	.meta({ id: "AttachmentRefPart" });
export type AttachmentRefPart = z.infer<typeof AttachmentRefPartSchema>;

export const TextPartSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
	})
	.meta({ id: "TextPart" });
export type TextPart = z.infer<typeof TextPartSchema>;

export const ImageUrlSchema = z
	.object({
		url: z.string(),
		detail: ImageDetailSchema.optional(),
		media_type: ImageMediaTypeSchema.optional(),
	})
	.meta({ id: "ImageUrl" });

export const ImagePartSchema = z
	.object({
		type: z.literal("image_url"),
		image_url: ImageUrlSchema,
	})
	.meta({ id: "ImagePart" });
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const DocumentPartSchema = z
	.object({
		type: z.literal("document"),
		source: z.object({
			data: z.string(),
			// Open: persisted content may carry document types added later.
			media_type: z.enum(["application/pdf"]),
		}),
	})
	.meta({ id: "DocumentPart" });
export type DocumentPart = z.infer<typeof DocumentPartSchema>;

export const OtherPartSchema = z
	.object({
		type: z.literal("other"),
		provider: z.string(),
		kind: z.string(),
		/** Provider-native payload; opaque to the protocol. */
		payload: z.unknown(),
	})
	.meta({ id: "OtherPart" });
export type OtherPart = z.infer<typeof OtherPartSchema>;

export const ContentPartSchema = tagged(
	"type",
	[
		TextPartSchema,
		ImagePartSchema,
		ImageRefPartSchema,
		AttachmentRefPartSchema,
		DocumentPartSchema,
		OtherPartSchema,
	],
	{ id: "ContentPart" },
);
export type ContentPart = z.infer<typeof ContentPartSchema>;
