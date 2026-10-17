import { IMAGE_REFERENCE_MAX_COUNT } from "@codelia/shared-types";
import type { ImageArtifactStore } from "@codelia/storage";
import { imageSize } from "image-size";
import { z } from "zod";
import { ImageGenerationError } from "./http";

export const IMAGE_REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_REFERENCE_TOTAL_BYTES = 32 * 1024 * 1024;
export { IMAGE_REFERENCE_MAX_COUNT };
export const imageArtifactId = z
	.string()
	.regex(/^codelia-image-[0-9a-f-]{36}$/);

export const imageSourceSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("url"),
			url: z
				.url({ protocol: /^https?$/ })
				.max(8192)
				.refine((value) => {
					if (!URL.canParse(value)) return false;
					const url = new URL(value);
					return !url.username && !url.password && !url.hash;
				}, "Image URL must not contain credentials or fragments")
				.describe(
					"Public direct PNG/JPEG/WebP URL on port 80/443, not a web page; no credentials or secrets. Downloaded in memory after approval; redirects and private network destinations are rejected.",
				),
		})
		.strict(),
	z
		.object({
			type: z.literal("file"),
			file_path: z
				.string()
				.min(1)
				.max(4096)
				.describe(
					"Runtime-host image path; sandbox-bounded unless full-access. Original bytes are read after approval.",
				),
		})
		.strict(),
	z
		.object({ type: z.literal("artifact"), artifact_id: imageArtifactId })
		.strict(),
]);
export type ImageSource = z.infer<typeof imageSourceSchema>;
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";
export type ImageReference = {
	type: "bytes";
	bytes: Uint8Array;
	media_type: ImageMediaType;
};
export type ImageSourceReader = (
	source: Exclude<ImageSource, { type: "artifact" }>,
	signal?: AbortSignal,
) => Promise<Uint8Array>;

/** Header validation only, not a full decoder; never re-encode input originals. */
export function validateImageReference(bytes: Uint8Array): ImageReference {
	if (!bytes.length || bytes.length > IMAGE_REFERENCE_MAX_BYTES)
		throw new ImageGenerationError(
			"Image reference is empty or exceeds 8 MiB; no generation was attempted.",
		);
	try {
		const header = Buffer.from(bytes.subarray(0, 12));
		const png = header
			.subarray(0, 8)
			.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
		const webp =
			header.toString("ascii", 0, 4) === "RIFF" &&
			header.toString("ascii", 8, 12) === "WEBP";
		if (!png && !jpeg && !webp) throw new Error("unsupported signature");
		const dimensions = imageSize(bytes);
		const media_type =
			dimensions.type === "png"
				? "image/png"
				: dimensions.type === "jpg"
					? "image/jpeg"
					: dimensions.type === "webp"
						? "image/webp"
						: null;
		if (
			!media_type ||
			!dimensions.width ||
			!dimensions.height ||
			dimensions.width > 4096 ||
			dimensions.height > 4096 ||
			dimensions.width * dimensions.height > 16_000_000
		)
			throw new Error("unsupported image headers");
		return { type: "bytes", bytes, media_type };
	} catch {
		throw new ImageGenerationError(
			"Image reference must have valid PNG/JPEG/WebP headers, at most 4096 pixels per side and 16 MP; no generation was attempted.",
		);
	}
}

export function imageReferenceDataUrl(reference: ImageReference): string {
	return `data:${reference.media_type};base64,${Buffer.from(reference.bytes).toString("base64")}`;
}

export async function resolveImageSources(
	sources: ImageSource[],
	store: ImageArtifactStore,
	readSource: ImageSourceReader | undefined,
	signal?: AbortSignal,
): Promise<ImageReference[]> {
	if (sources.length > IMAGE_REFERENCE_MAX_COUNT)
		throw new ImageGenerationError(
			"Too many image references; no generation was attempted.",
		);
	const references: ImageReference[] = [];
	let total = 0;
	try {
		for (const source of sources) {
			signal?.throwIfAborted();
			let bytes: Uint8Array;
			if (source.type === "artifact")
				bytes = (await store.read(source.artifact_id)).bytes;
			else {
				if (!readSource)
					throw new ImageGenerationError(
						"URL/file image references are unavailable in this environment; no generation was attempted.",
					);
				bytes = await readSource(source, signal);
			}
			signal?.throwIfAborted();
			const reference = validateImageReference(bytes);
			total += bytes.length;
			if (total > IMAGE_REFERENCE_TOTAL_BYTES)
				throw new ImageGenerationError(
					"Image references exceed the 32 MiB combined limit; no generation was attempted.",
				);
			references.push(reference);
		}
		return references;
	} catch (error) {
		if (error instanceof ImageGenerationError) throw error;
		throw new ImageGenerationError(
			"Image reference could not be read or was cancelled; no generation was attempted.",
		);
	}
}
