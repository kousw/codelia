/** Persistence/schema safety ceiling, not a provider capability promise. */
export const IMAGE_REFERENCE_MAX_COUNT = 16;

export type ImageMediaType =
	| "image/png"
	| "image/jpeg"
	| "image/webp"
	| "image/gif";

/** Fixed model input representation; absent means the immutable original. */
export type ImageModelView = {
	version: "jpeg-q90-444-v1";
	media_type: "image/jpeg";
	sha256: string;
	byte_size: number;
};

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
		view.byte_size <= 8 * 1024 * 1024
	);
}

/** Durable image identity. Bytes are resolved only at the request/preview boundary. */
export type ImageArtifactRef = {
	artifact_id: string;
	sha256: string;
	media_type: ImageMediaType;
	byte_size: number;
	width: number;
	height: number;
	model_view?: ImageModelView;
};
export type GeneratedImageMetadata = ImageArtifactRef & {
	kind?: "generated";
	media_type: "image/png";
	created_at: string;
	provider: string;
	requested_model: string;
	effective_model?: string;
	endpoint: string;
	parent_artifact_ids: string[];
	usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
};

export type AttachedImageMetadata = ImageArtifactRef & {
	kind: "attachment";
	created_at: string;
};

export type ImageArtifactMetadata =
	| GeneratedImageMetadata
	| AttachedImageMetadata;
