import { z } from "zod";
import { type ImageFetch, ImageGenerationError, imageJson } from "./http";

const slug = z
	.string()
	.max(160)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
const descriptor = z.union([
	z.object({
		type: z.literal("enum"),
		values: z.array(z.string().max(100)).max(128),
	}),
	z.object({
		type: z.literal("range"),
		min: z.number().finite(),
		max: z.number().finite(),
	}),
	z.object({ type: z.literal("boolean") }),
]);
const endpointSchema = z.object({
	provider_tag: slug.nullable(),
	supported_parameters: z.record(z.string(), descriptor),
});
export type ImageEndpoint = z.infer<typeof endpointSchema>;
export type ImageModelListing = { id: string; name: string };
export class ImageCatalog {
	private cached?: {
		models: ImageModelListing[];
		fetched_at: string;
		expires: number;
	};
	constructor(private readonly fetcher: ImageFetch = fetch) {}
	async list(): Promise<{
		models: ImageModelListing[];
		fetched_at: string;
		stale: boolean;
	}> {
		if (this.cached && this.cached.expires > Date.now())
			return { ...this.cached, stale: false };
		try {
			const raw = await imageJson(
				"https://openrouter.ai/api/v1/images/models",
				{},
				this.fetcher,
				4 * 1024 * 1024,
				15_000,
			);
			const parsed = z
				.object({
					data: z
						.array(
							z.object({
								id: slug,
								name: z.string().max(256),
								architecture: z.object({
									output_modalities: z.array(z.string()),
								}),
							}),
						)
						.max(2000),
				})
				.safeParse(raw);
			if (!parsed.success)
				throw new ImageGenerationError("Invalid image model catalog.");
			const models = parsed.data.data
				.filter((m) => m.architecture.output_modalities.includes("image"))
				.map((m) => ({
					id: m.id,
					name: [...m.name]
						.filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
						.join(""),
				}));
			this.cached = {
				models,
				fetched_at: new Date().toISOString(),
				expires: Date.now() + 300_000,
			};
			return { ...this.cached, stale: false };
		} catch (error) {
			if (this.cached) return { ...this.cached, stale: true };
			throw error;
		}
	}
	async endpoints(
		model: string,
		signal?: AbortSignal,
	): Promise<ImageEndpoint[]> {
		if (!slug.safeParse(model).success)
			throw new ImageGenerationError("Invalid image model id.");
		const raw = await imageJson(
			`https://openrouter.ai/api/v1/images/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
			{ signal },
			this.fetcher,
			1024 * 1024,
			15_000,
		);
		const parsed = z
			.object({ endpoints: z.array(endpointSchema).max(100) })
			.safeParse(raw);
		if (!parsed.success)
			throw new ImageGenerationError("Invalid image endpoint catalog.");
		return parsed.data.endpoints.filter(
			(e) =>
				e.provider_tag &&
				(!e.supported_parameters.output_format ||
					acceptsParameter(e, "output_format", "png")),
		);
	}
}
export function acceptsParameter(
	endpoint: ImageEndpoint,
	key: string,
	value: unknown,
): boolean {
	const rule = endpoint.supported_parameters[key];
	if (!rule) return false;
	if (rule.type === "enum")
		return typeof value === "string" && rule.values.includes(value);
	if (rule.type === "range")
		return (
			typeof value === "number" &&
			Number.isInteger(value) &&
			value >= rule.min &&
			value <= rule.max
		);
	return true; // Boolean descriptor denotes support, not a boolean wire value.
}
