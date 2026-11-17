export type AttachmentUploadLimits = {
	max_file_bytes: number;
	max_message_bytes: number;
	max_attachments: number;
	max_chunk_bytes: number;
	max_concurrent_uploads: number;
};

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
