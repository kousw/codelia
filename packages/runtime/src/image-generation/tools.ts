import {
	type ContentPart,
	defineTool,
	type Tool,
	ToolPermissionDenied,
	type ToolPermissionHook,
} from "@codelia/core";
import type {
	ImageArtifactMetadata,
	ImageArtifactRef,
} from "@codelia/shared-types";
import type { ImageArtifactStore } from "@codelia/storage";
import { z } from "zod";
import { prepareImageGeneration } from "./adapter";
import { type ImageFetch, ImageGenerationError } from "./http";
import {
	imageArtifactId as artifactId,
	IMAGE_REFERENCE_MAX_COUNT,
	type ImageSource,
	type ImageSourceReader,
	imageSourceSchema,
	resolveImageSources,
} from "./references";
import type { ImageRoute } from "./route";

const imageParts = (
	m: ImageArtifactMetadata,
	ref: ImageArtifactRef,
): ContentPart[] => {
	const provenance =
		m.kind === "attachment"
			? "Source: user attachment (not generated)."
			: `Provider: ${m.provider}; requested model: ${m.requested_model}; effective model: ${m.effective_model ?? "unknown"}. Cost: ${m.usage?.cost_usd === undefined ? "unknown" : `${m.usage.cost_usd} USD`}.`;
	return [
		{
			type: "text",
			text: `Image artifact: ${m.artifact_id}\n${m.width}x${m.height}, ${m.byte_size} bytes, ${m.media_type}\n${provenance}\nPreview: /image-artifact ${m.artifact_id}\nUse image_inspect to revisit; image_generate images with type=artifact to edit. Original is immutable.${ref.model_view ? " Model input uses a fixed JPEG quality-90 view; inspect with original=true for exact pixels." : ""}\n`,
		},
		{ type: "image_ref", image_ref: ref },
	];
};
export function createImageTools(input: {
	store: ImageArtifactStore;
	route: ImageRoute | null;
	authorize: ToolPermissionHook;
	fetcher?: ImageFetch;
	readSource?: ImageSourceReader;
	exportImage?: (
		outputPath: string,
		bytes: Buffer,
		mediaType: "image/png" | "image/jpeg",
	) => Promise<string>;
}): Tool[] {
	const tools: Tool[] = [
		defineTool({
			name: "image_inspect",
			description:
				"Revisit one saved image artifact in this workspace without generating or charging. Generated opaque images use a smaller fixed JPEG view by default. Use original=true for exact pixels or fine text; this does not replace earlier images. Attachments and transparent images keep originals.",
			input: z.object({
				artifact_id: artifactId.describe(
					"Saved codelia-image artifact id from a prior image result.",
				),
				original: z
					.boolean()
					.optional()
					.describe(
						"Use original pixels for this inspection instead of the generated-image JPEG view.",
					),
			}),
			execute: async ({ artifact_id, original }) =>
				imageParts(
					(await input.store.read(artifact_id)).metadata,
					await input.store.modelReference(artifact_id, original),
				),
		}),
	];
	const exportImage = input.exportImage;
	if (exportImage)
		tools.push(
			defineTool({
				name: "image_export",
				description:
					"Export immutable original PNG or JPEG bytes to a new matching-extension file in the runtime workspace. No generation or charge; never overwrites an existing file. Parent directory must exist. SSH paths remain runtime-host paths.",
				input: z.object({
					artifact_id: artifactId.describe("Saved image artifact id."),
					output_path: z
						.string()
						.min(1)
						.max(4096)
						.describe(
							"New .png, .jpg, or .jpeg file matching the artifact format inside the runtime workspace; parent directory must already exist.",
						),
				}),
				execute: async (args, ctx) => {
					const raw = JSON.stringify(args);
					const decision = await input.authorize(
						{
							id: "codelia-image-export",
							type: "function",
							function: { name: "image_export", arguments: raw },
						},
						raw,
						ctx,
					);
					if (decision.decision !== "allow")
						throw new ToolPermissionDenied(decision);
					ctx.signal?.throwIfAborted();
					const { bytes, metadata } = await input.store.read(args.artifact_id);
					if (
						metadata.media_type !== "image/png" &&
						metadata.media_type !== "image/jpeg"
					)
						throw new ImageGenerationError(
							"Only PNG/JPEG originals can be exported. No conversion was performed.",
						);
					return `Image exported (runtime host path): ${await exportImage(args.output_path, bytes, metadata.media_type)}\nOriginal artifact unchanged: ${args.artifact_id}`;
				},
			}),
		);
	const route = input.route;
	if (!route) return tools;
	const billing =
		route.authMode === "codex_oauth"
			? "current Codex OAuth account; image usage/limits apply; no public API-key billing fallback"
			: "chargeable image API; price unknown unless reported";
	let busy = false;
	tools.push(
		defineTool({
			name: "image_generate",
			description: `Generate or edit images using selected ${route.provider}/${route.model} (${route.endpoint}); ${billing}. Only use when the user requests images. Supply images explicitly; viewing an image does not select it. Returns immutable artifacts and image inputs. No automatic retry or fallback; timeout may consume usage. PNG/JPEG output max 32 MiB/12288px/20 MP.`,
			input: z
				.object({
					prompt: z
						.string()
						.trim()
						.min(1)
						.max(16000)
						.describe(
							"Image generation/edit instruction; refer to images by their 1-based order and describe what to preserve/change. Do not include credentials or unrelated private data.",
						),
					images: z
						.array(imageSourceSchema)
						.max(IMAGE_REFERENCE_MAX_COUNT)
						.optional()
						.describe(
							"Ordered reference images (URL/file/artifact); omit for text-only generation. Up to 16 total, further limited by route: Codex 5, Google 14, OpenRouter endpoint-specific. PNG/JPEG/WebP, max 32 MiB each/128 MiB combined, 12288px per side/20 MP. Original bytes are acquired after approval; failure aborts generation. Cannot combine with reference_artifact_ids.",
						),
					reference_artifact_ids: z
						.array(artifactId)
						.max(IMAGE_REFERENCE_MAX_COUNT)
						.optional()
						.describe(
							"Legacy artifact-only alternative to images, subject to the same route/count/byte limits. Do not combine with images; prefer images with type=artifact.",
						),
				})
				.refine(
					(args) =>
						args.images === undefined ||
						args.reference_artifact_ids === undefined,
					"Provide images or reference_artifact_ids, not both",
				),
			execute: async (args, ctx) => {
				if (busy)
					throw new ImageGenerationError(
						"An image generation request is already active; wait for it rather than retrying.",
					);
				busy = true;
				try {
					const raw = {
						...args,
						provider: route.provider,
						requested_model: route.model,
						endpoint: route.endpoint,
						auth_mode: route.authMode,
						billing,
					};
					const decision = await input.authorize(
						{
							id: "codelia-image-generation",
							type: "function",
							function: {
								name: "image_generate",
								arguments: JSON.stringify(raw),
							},
						},
						JSON.stringify(raw),
						ctx,
					);
					if (decision.decision !== "allow")
						throw new ToolPermissionDenied(decision);
					ctx.signal?.throwIfAborted();
					const sources: ImageSource[] =
						args.images ??
						(args.reference_artifact_ids ?? []).map((artifact_id) => ({
							type: "artifact",
							artifact_id,
						}));
					const generate = await prepareImageGeneration(
						route,
						sources.length,
						ctx.signal,
						input.fetcher,
					);
					const references = await resolveImageSources(
						sources,
						input.store,
						input.readSource,
						ctx.signal,
					);
					const ids = sources.flatMap((source) =>
						source.type === "artifact" ? [source.artifact_id] : [],
					);
					const result = await generate(args.prompt, references);
					ctx.signal?.throwIfAborted();
					const outputs = result.images ?? [
						{
							bytes: result.bytes,
							media_type: result.media_type ?? "image/png",
						},
					];
					const parts: ContentPart[] = [];
					for (const output of outputs) {
						const metadata = await input.store.save(
							output.bytes,
							{
								provider: route.provider,
								requested_model: route.model,
								endpoint: route.endpoint,
								parent_artifact_ids: ids,
								...(result.effective_model
									? { effective_model: result.effective_model }
									: {}),
								...(result.usage ? { usage: result.usage } : {}),
							},
							output.media_type,
						);
						try {
							parts.push(
								...imageParts(
									metadata,
									await input.store.modelReference(metadata.artifact_id),
								),
							);
						} catch {
							const {
								artifact_id,
								sha256,
								media_type,
								byte_size,
								width,
								height,
							} = metadata;
							parts.push(
								...imageParts(metadata, {
									artifact_id,
									sha256,
									media_type,
									byte_size,
									width,
									height,
								}),
							);
							parts.push({
								type: "text",
								text: "JPEG model view could not be prepared. Generation succeeded and the original is saved; this new reference uses original pixels. Do not regenerate.",
							});
						}
					}
					return parts;
				} catch (error) {
					if (
						error instanceof ToolPermissionDenied ||
						error instanceof ImageGenerationError
					)
						throw error;
					throw new ImageGenerationError(
						"Image generation or artifact persistence failed. No fallback or automatic retry was attempted; the provider may already have charged. Check runtime storage and selected route.",
					);
				} finally {
					busy = false;
				}
			},
		}),
	);
	return tools;
}
