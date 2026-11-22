import { ImageArtifactMetadataSchema } from "@codelia/shared-types";
import { z } from "zod";

export const ImageModelModeSchema = z
	.enum(["off", "builtin", "custom"])
	.meta({ id: "ImageModelMode" });

export const ImageModelGetParamsSchema = z
	.object({})
	.meta({ id: "ImageModelGetParams" });

export const ImageModelConfigureParamsSchema = z
	.object({
		/** Omitted (with no other field) opens the interactive picker. */
		mode: ImageModelModeSchema.optional(),
		provider: z.enum(["openai", "openrouter", "google"]).optional(),
		model: z.string().optional(),
		/** OpenRouter endpoint to pin. */
		endpoint: z.string().optional(),
		api_key_env: z.string().optional(),
		/** Google only. */
		image_size: z.enum(["1K", "2K", "4K"]).optional(),
		/** Google only. */
		aspect_ratio: z.string().optional(),
		/** Google only. */
		output_format: z.enum(["jpeg"]).optional(),
	})
	.meta({ id: "ImageModelConfigureParams" });
export type ImageModelConfigureParams = z.infer<
	typeof ImageModelConfigureParamsSchema
>;

export const ImageModelStatusSchema = z
	.object({
		auth_mode: z.enum(["api_key", "codex_oauth"]).optional(),
		requested_mode: ImageModelModeSchema,
		state: z.enum(["disabled", "available", "unavailable"]),
		message: z.string(),
		provider: z.string().optional(),
		requested_model: z.string().optional(),
		endpoint: z.string().optional(),
	})
	.meta({ id: "ImageModelStatus" });
export type ImageModelStatus = z.infer<typeof ImageModelStatusSchema>;

/**
 * The saved route's status, or only `message` when the user left the
 * settings unchanged.
 */
export const ImageModelConfigureResultSchema = ImageModelStatusSchema.partial()
	.required({ message: true })
	.meta({ id: "ImageModelConfigureResult" });
export type ImageModelConfigureResult = z.infer<
	typeof ImageModelConfigureResultSchema
>;

export const ImageArtifactGetParamsSchema = z
	.object({ artifact_id: z.string() })
	.meta({ id: "ImageArtifactGetParams" });
export type ImageArtifactGetParams = z.infer<
	typeof ImageArtifactGetParamsSchema
>;

export const ImageArtifactGetResultSchema = z
	.object({
		metadata: ImageArtifactMetadataSchema,
		/** Bounded inline PNG for local/SSH clients; never a runtime-host path. */
		data_url: z.string(),
	})
	.meta({ id: "ImageArtifactGetResult" });
export type ImageArtifactGetResult = z.infer<
	typeof ImageArtifactGetResultSchema
>;
