import {
	type GeneratedImageMetadata,
	IMAGE_REFERENCE_MAX_COUNT,
	type ImageArtifactMetadata,
} from "@codelia/shared-types";

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const label = (value: unknown, max: number): value is string =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= max &&
	[...value].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127);
const id = (value: unknown): value is string =>
	typeof value === "string" && /^codelia-image-[0-9a-f-]{36}$/.test(value);
const positive = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Persisted provenance is untrusted, even when the image hash still matches. */
export function parseImageMetadata(value: unknown): ImageArtifactMetadata {
	if (
		!record(value) ||
		!id(value.artifact_id) ||
		typeof value.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sha256) ||
		!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
			String(value.media_type),
		) ||
		!positive(value.byte_size) ||
		!positive(value.width) ||
		!positive(value.height) ||
		!label(value.created_at, 40) ||
		!Number.isFinite(Date.parse(value.created_at))
	)
		throw new Error("Invalid image artifact metadata");
	if (value.kind === "attachment") {
		if (
			[
				"provider",
				"requested_model",
				"endpoint",
				"usage",
				"parent_artifact_ids",
			].some((key) => key in value)
		)
			throw new Error("Invalid attachment provenance");
		return {
			kind: "attachment",
			artifact_id: value.artifact_id,
			sha256: value.sha256,
			media_type: value.media_type as ImageArtifactMetadata["media_type"],
			byte_size: value.byte_size,
			width: value.width,
			height: value.height,
			created_at: value.created_at,
		};
	}
	if (
		(value.kind !== undefined && value.kind !== "generated") ||
		value.media_type !== "image/png" ||
		!label(value.provider, 160) ||
		!label(value.requested_model, 160) ||
		!label(value.endpoint, 256) ||
		(value.effective_model !== undefined &&
			!label(value.effective_model, 160)) ||
		!Array.isArray(value.parent_artifact_ids) ||
		value.parent_artifact_ids.length > IMAGE_REFERENCE_MAX_COUNT ||
		!value.parent_artifact_ids.every(id)
	)
		throw new Error("Invalid image artifact metadata");
	let usage: GeneratedImageMetadata["usage"];
	if (value.usage !== undefined) {
		if (!record(value.usage)) throw new Error("Invalid image usage metadata");
		usage = {};
		for (const key of ["input_tokens", "output_tokens", "cost_usd"] as const) {
			const number = value.usage[key];
			if (number === undefined) continue;
			if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
				throw new Error("Invalid image usage metadata");
			usage[key] = number;
		}
	}
	return {
		artifact_id: value.artifact_id,
		sha256: value.sha256,
		media_type: value.media_type,
		byte_size: value.byte_size,
		width: value.width,
		height: value.height,
		created_at: value.created_at,
		provider: value.provider,
		requested_model: value.requested_model,
		endpoint: value.endpoint,
		parent_artifact_ids: value.parent_artifact_ids,
		...(value.effective_model !== undefined
			? { effective_model: value.effective_model }
			: {}),
		...(usage ? { usage } : {}),
	};
}
