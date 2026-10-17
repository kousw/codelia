/**
 * Message Content Parts
 */
export type ImageRefPart = {
	type: "image_ref";
	image_ref: import("@codelia/shared-types").ImageArtifactRef;
	detail?: "auto" | "low" | "high";
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
	| DocumentPart
	| OtherPart;
