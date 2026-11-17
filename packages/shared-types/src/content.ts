import type { AttachmentRef } from "./attachment";
import type { ImageArtifactRef } from "./image-artifact";

/**
 * Message Content Parts
 */
export type ImageRefPart = {
	type: "image_ref";
	image_ref: ImageArtifactRef;
	detail?: "auto" | "low" | "high";
};

export type AttachmentRefPart = {
	type: "attachment_ref";
	attachment_ref: AttachmentRef;
	image_ref?: ImageArtifactRef;
};

export type TextPart = {
	type: "text";
	text: string;
};

export type ImagePart = {
	type: "image_url";
	image_url: {
		url: string;
		detail?: "auto" | "low" | "high";
		media_type?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
	};
};

export type DocumentPart = {
	type: "document";
	source: { data: string; media_type: "application/pdf" };
};

export type OtherPart = {
	type: "other";
	provider: string;
	kind: string;
	payload: unknown;
};

export type ContentPart =
	| TextPart
	| ImagePart
	| ImageRefPart
	| AttachmentRefPart
	| DocumentPart
	| OtherPart;
