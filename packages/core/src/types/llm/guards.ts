import { ATTACHMENT_ID_PATTERN, isImageModelView } from "@codelia/shared-types";
import type {
	AttachmentRefPart,
	ContentPart,
	DocumentPart,
	ImagePart,
	OtherPart,
	TextPart,
} from "./content";
import type { ToolResult } from "./tools";

const TOOL_RESULT_TYPES = new Set(["text", "parts", "json"]);

export function isTextPart(value: unknown): value is TextPart {
	if (!value || typeof value !== "object") return false;
	const v = value as { type?: unknown; text?: unknown };
	return v.type === "text" && typeof v.text === "string";
}

export function isImagePart(value: unknown): value is ImagePart {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		type?: unknown;
		image_url?: { url?: unknown; detail?: unknown; media_type?: unknown };
	};
	if (v.type !== "image_url") return false;
	if (!v.image_url || typeof v.image_url !== "object") return false;
	const url = (v.image_url as { url?: unknown }).url;
	return typeof url === "string";
}

export function isDocumentPart(value: unknown): value is DocumentPart {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		type?: unknown;
		source?: { data?: unknown; media_type?: unknown };
	};
	if (v.type !== "document") return false;
	if (!v.source || typeof v.source !== "object") return false;
	const source = v.source as { data?: unknown; media_type?: unknown };
	return (
		typeof source.data === "string" && source.media_type === "application/pdf"
	);
}

export function isOtherPart(value: unknown): value is OtherPart {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		type?: unknown;
		provider?: unknown;
		kind?: unknown;
	};
	return (
		v.type === "other" &&
		typeof v.provider === "string" &&
		typeof v.kind === "string"
	);
}

export function isContentPart(value: unknown): value is ContentPart {
	return (
		isTextPart(value) ||
		isImagePart(value) ||
		isImageRefPart(value) ||
		isAttachmentRefPart(value) ||
		isDocumentPart(value) ||
		isOtherPart(value)
	);
}

export function isAttachmentRefPart(
	value: unknown,
): value is AttachmentRefPart {
	if (!value || typeof value !== "object") return false;
	const part = value as Record<string, unknown>;
	if (
		part.type !== "attachment_ref" ||
		!part.attachment_ref ||
		typeof part.attachment_ref !== "object"
	)
		return false;
	const ref = part.attachment_ref as Record<string, unknown>;
	return (
		typeof ref.attachment_id === "string" &&
		ATTACHMENT_ID_PATTERN.test(ref.attachment_id) &&
		typeof ref.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(ref.sha256) &&
		typeof ref.byte_size === "number" &&
		Number.isSafeInteger(ref.byte_size) &&
		ref.byte_size >= 0 &&
		typeof ref.display_name === "string" &&
		ref.display_name.length > 0 &&
		ref.display_name.length <= 255 &&
		typeof ref.media_type === "string" &&
		/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(ref.media_type) &&
		(ref.origin === undefined ||
			ref.origin === "file" ||
			ref.origin === "clipboard_image") &&
		[ref.width, ref.height].every(
			(size) =>
				size === undefined ||
				(typeof size === "number" && Number.isSafeInteger(size) && size > 0),
		) &&
		(part.image_ref === undefined ||
			isImageRefPart({ type: "image_ref", image_ref: part.image_ref }))
	);
}

export function isImageRefPart(
	value: unknown,
): value is import("./content").ImageRefPart {
	if (!value || typeof value !== "object") return false;
	const v = value as { type?: unknown; image_ref?: unknown; detail?: unknown };
	if (v.type !== "image_ref" || !v.image_ref || typeof v.image_ref !== "object")
		return false;
	const r = v.image_ref as Record<string, unknown>;
	return (
		(r.model_view === undefined || isImageModelView(r.model_view)) &&
		typeof r.artifact_id === "string" &&
		/^codelia-image-[0-9a-f-]{36}$/.test(r.artifact_id) &&
		typeof r.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(r.sha256) &&
		["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
			String(r.media_type),
		) &&
		(v.detail === undefined ||
			["auto", "low", "high"].includes(String(v.detail))) &&
		[r.byte_size, r.width, r.height].every(
			(n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0,
		) &&
		Number(r.byte_size) <= 8 * 1024 * 1024 &&
		Number(r.width) <= 4096 &&
		Number(r.height) <= 4096 &&
		Number(r.width) * Number(r.height) <= 16_000_000
	);
}

export function isToolResult(value: unknown): value is ToolResult {
	if (!value || typeof value !== "object") return false;
	const v = value as { type?: unknown };

	if (!TOOL_RESULT_TYPES.has(String(v.type))) return false;
	if (v.type === "text")
		return typeof (value as { text?: unknown }).text === "string";
	if (v.type === "json") return "value" in (value as { value?: unknown });
	if (v.type === "parts") {
		const parts = (value as { parts?: unknown }).parts;
		return Array.isArray(parts) && parts.every(isContentPart);
	}
	return false;
}
