import { wireInt } from "@codelia/shared-types";
import { z } from "zod";

export const AttachmentUploadLimitsSchema = z
	.object({
		max_file_bytes: wireInt(),
		max_message_bytes: wireInt(),
		max_attachments: wireInt(),
		max_chunk_bytes: wireInt(),
		max_concurrent_uploads: wireInt(),
	})
	.meta({ id: "AttachmentUploadLimits" });
export type AttachmentUploadLimits = z.infer<
	typeof AttachmentUploadLimitsSchema
>;

export const AttachmentUploadBeginParamsSchema = z
	.object({
		/** Client key that makes a retried begin idempotent. */
		upload_key: z.string(),
		display_name: z.string(),
		byte_size: wireInt(),
		/** Lowercase hex SHA-256 of the whole file. */
		sha256: z.string(),
		session_id: z.string().optional(),
	})
	.meta({ id: "AttachmentUploadBeginParams" });
export type AttachmentUploadBeginParams = z.infer<
	typeof AttachmentUploadBeginParamsSchema
>;

export const AttachmentUploadBeginResultSchema = z
	.object({ upload_id: z.string(), offset: wireInt() })
	.meta({ id: "AttachmentUploadBeginResult" });
export type AttachmentUploadBeginResult = z.infer<
	typeof AttachmentUploadBeginResultSchema
>;

export const AttachmentUploadChunkParamsSchema = z
	.object({
		upload_id: z.string(),
		offset: wireInt(),
		/** Base64 chunk. */
		data: z.string(),
	})
	.meta({ id: "AttachmentUploadChunkParams" });
export type AttachmentUploadChunkParams = z.infer<
	typeof AttachmentUploadChunkParamsSchema
>;

export const AttachmentUploadChunkResultSchema = z
	.object({ offset: wireInt() })
	.meta({ id: "AttachmentUploadChunkResult" });
export type AttachmentUploadChunkResult = z.infer<
	typeof AttachmentUploadChunkResultSchema
>;

export const AttachmentUploadIdParamsSchema = z
	.object({ upload_id: z.string() })
	.meta({ id: "AttachmentUploadIdParams" });
export type AttachmentUploadFinishParams = z.infer<
	typeof AttachmentUploadIdParamsSchema
>;
export type AttachmentUploadCancelParams = AttachmentUploadFinishParams;

export const AttachmentUploadFinishResultSchema = z
	.object({ attachment_id: z.string() })
	.meta({ id: "AttachmentUploadFinishResult" });
export type AttachmentUploadFinishResult = z.infer<
	typeof AttachmentUploadFinishResultSchema
>;

export const AttachmentUploadCancelResultSchema = z
	.object({ ok: z.literal(true) })
	.meta({ id: "AttachmentUploadCancelResult" });
export type AttachmentUploadCancelResult = z.infer<
	typeof AttachmentUploadCancelResultSchema
>;
