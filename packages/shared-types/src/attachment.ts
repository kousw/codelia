export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Immutable runtime-owned attachment metadata. No source path is retained. */
export type AttachmentRef = {
	attachment_id: string;
	sha256: string;
	byte_size: number;
	media_type: string;
	display_name: string;
	width?: number;
	height?: number;
	origin?: "file" | "clipboard_image";
};
