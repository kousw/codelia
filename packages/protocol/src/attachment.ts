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

export type AttachmentUploadBeginParams = {
	upload_key: string;
	display_name: string;
	byte_size: number;
	sha256: string;
	session_id?: string;
};
export type AttachmentUploadBeginResult = { upload_id: string; offset: number };
export type AttachmentUploadChunkParams = {
	upload_id: string;
	offset: number;
	data: string;
};
export type AttachmentUploadChunkResult = { offset: number };
export type AttachmentUploadFinishParams = { upload_id: string };
export type AttachmentUploadFinishResult = { attachment_id: string };
export type AttachmentUploadCancelParams = { upload_id: string };
export type AttachmentUploadCancelResult = { ok: true };
