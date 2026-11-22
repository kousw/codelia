import { z } from "zod";
import { wireInt } from "./wire";

export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Immutable runtime-owned attachment metadata. No source path is retained. */
export const AttachmentRefSchema = z
	.object({
		attachment_id: z.string(),
		sha256: z.string(),
		byte_size: wireInt(),
		media_type: z.string(),
		display_name: z.string(),
		width: wireInt().optional(),
		height: wireInt().optional(),
		origin: z.enum(["file", "clipboard_image"]).optional(),
	})
	.meta({
		id: "AttachmentRef",
		description:
			"Immutable runtime-owned attachment metadata. No source path is retained.",
	});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
