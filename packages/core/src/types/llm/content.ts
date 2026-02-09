/**
 * Message Content Parts
 */
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

export type ContentPart = TextPart | ImagePart | DocumentPart | OtherPart;
