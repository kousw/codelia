import type { GeneratedImageMetadata } from "@codelia/shared-types";
import { IMAGE_MAX_BYTES } from "@codelia/storage";
import { z } from "zod";
import { acceptsParameter, ImageCatalog, type ImageEndpoint } from "./catalog";
import { requestCodexImage } from "./codex";
import { type ImageFetch, ImageGenerationError, imageJson } from "./http";
import {
	IMAGE_REFERENCE_MAX_COUNT,
	IMAGE_REFERENCE_TOTAL_BYTES,
	type ImageReference,
	imageReferenceDataUrl,
	validateImageReference,
} from "./references";
import type { ImageRoute } from "./route";

const responseSchema = z.object({
	data: z
		.array(
			z.object({
				b64_json: z
					.string()
					.min(1)
					.max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
				media_type: z.literal("image/png").optional(),
			}),
		)
		.length(1),
	model: z
		.string()
		.max(160)
		.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/)
		.optional(),
	usage: z
		.object({
			input_tokens: z.number().finite().nonnegative().optional(),
			output_tokens: z.number().finite().nonnegative().optional(),
			prompt_tokens: z.number().finite().nonnegative().optional(),
			completion_tokens: z.number().finite().nonnegative().optional(),
			cost: z.number().finite().nonnegative().optional(),
		})
		.optional(),
});
/** Resolve endpoint capabilities once, before reading references or charging. */
export async function prepareImageGeneration(
	route: ImageRoute,
	referenceCount: number,
	signal?: AbortSignal,
	fetcher: ImageFetch = fetch,
): Promise<
	(prompt: string, references: ImageReference[]) => ReturnType<typeof sendImage>
> {
	signal?.throwIfAborted();
	const max = route.authMode === "codex_oauth" ? 5 : IMAGE_REFERENCE_MAX_COUNT;
	if (
		!Number.isInteger(referenceCount) ||
		referenceCount < 0 ||
		referenceCount > max
	)
		throw new ImageGenerationError(
			`Selected image route supports at most ${max} references; no generation was attempted.`,
		);
	let endpoint: ImageEndpoint | undefined;
	if (route.provider === "openrouter") {
		endpoint = (
			await new ImageCatalog(fetcher).endpoints(route.model, signal)
		).find((e) => e.provider_tag === route.endpoint);
		if (!endpoint)
			throw new ImageGenerationError(
				"Selected image endpoint is unavailable or explicitly excludes PNG output.",
			);
		if (endpoint.supported_parameters.n && !acceptsParameter(endpoint, "n", 1))
			throw new ImageGenerationError(
				"Selected image endpoint does not support a single image.",
			);
		for (const [key, value] of Object.entries(route.options))
			if (!acceptsParameter(endpoint, key, value))
				throw new ImageGenerationError(
					`Selected image endpoint does not support configured ${key}.`,
				);
		if (
			referenceCount &&
			!acceptsParameter(endpoint, "input_references", referenceCount)
		)
			throw new ImageGenerationError(
				"Selected image endpoint does not support this reference count; no generation was attempted.",
			);
	}
	return async (prompt, references) => {
		if (references.length !== referenceCount)
			throw new ImageGenerationError(
				"Image reference count changed after preparation; no generation was attempted.",
			);
		let total = 0;
		for (const reference of references) {
			const validated = validateImageReference(reference.bytes);
			if (validated.media_type !== reference.media_type)
				throw new ImageGenerationError(
					"Image reference media type mismatch; no generation was attempted.",
				);
			total += reference.bytes.length;
		}
		if (total > IMAGE_REFERENCE_TOTAL_BYTES)
			throw new ImageGenerationError(
				"Image references exceed the 32 MiB combined limit; no generation was attempted.",
			);
		return sendImage(route, prompt, references, signal, fetcher, endpoint);
	};
}

export async function generateImage(
	route: ImageRoute,
	prompt: string,
	references: ImageReference[],
	signal?: AbortSignal,
	fetcher: ImageFetch = fetch,
) {
	return (
		await prepareImageGeneration(route, references.length, signal, fetcher)
	)(prompt, references);
}

async function sendImage(
	route: ImageRoute,
	prompt: string,
	references: ImageReference[],
	signal?: AbortSignal,
	fetcher: ImageFetch = fetch,
	endpoint?: ImageEndpoint,
): Promise<{
	bytes: Buffer;
	effective_model?: string;
	usage?: GeneratedImageMetadata["usage"];
}> {
	if (route.authMode === "codex_oauth")
		return parseImageResponse(
			await requestCodexImage(route, prompt, references, signal, fetcher),
		);
	let url = route.endpoint;
	let body: BodyInit;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${route.apiKey}`,
	};
	if (route.provider === "openai" && references.length) {
		url = "https://api.openai.com/v1/images/edits";
		const form = new FormData();
		form.set("model", route.model);
		form.set("prompt", prompt);
		form.set("n", "1");
		form.set("output_format", "png");
		for (const [key, value] of Object.entries(route.options))
			form.set(key, value);
		for (const [i, reference] of references.entries())
			form.append(
				"image[]",
				new Blob([new Uint8Array(reference.bytes)], {
					type: reference.media_type,
				}),
				`reference-${i}.${reference.media_type.split("/")[1]}`,
			);
		body = form;
	} else {
		const fields: Record<string, unknown> = {
			model: route.model,
			prompt,
			n: 1,
			output_format: "png",
			...route.options,
		};
		if (route.provider === "openrouter") {
			url = "https://openrouter.ai/api/v1/images";
			if (!endpoint)
				throw new ImageGenerationError(
					"Selected image endpoint is unavailable or explicitly excludes PNG output.",
				);
			if (!endpoint.supported_parameters.output_format)
				delete fields.output_format;
			if (!endpoint.supported_parameters.n) delete fields.n;
			fields.provider = { only: [route.endpoint], allow_fallbacks: false };
			if (references.length) {
				fields.input_references = references.map((reference) => ({
					type: "image_url",
					image_url: {
						url: imageReferenceDataUrl(reference),
					},
				}));
			}
		}
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(fields);
	}
	signal?.throwIfAborted();
	return parseImageResponse(
		await imageJson(url, { method: "POST", headers, body, signal }, fetcher),
	);
}

function parseImageResponse(raw: unknown): {
	bytes: Buffer;
	effective_model?: string;
	usage?: GeneratedImageMetadata["usage"];
} {
	const parsed = responseSchema.safeParse(raw);
	if (!parsed.success)
		throw new ImageGenerationError(
			"Image API returned no complete supported image; generation was not recorded as successful.",
		);
	const base64 = parsed.data.data[0]?.b64_json ?? "";
	const bytes = Buffer.from(base64, "base64");
	if (
		!bytes.length ||
		bytes.length > IMAGE_MAX_BYTES ||
		bytes.toString("base64") !== base64
	)
		throw new ImageGenerationError(
			"Image API returned invalid or oversized base64.",
		);
	const u = parsed.data.usage;
	const usage = u
		? {
				input_tokens: u.input_tokens ?? u.prompt_tokens,
				output_tokens: u.output_tokens ?? u.completion_tokens,
				cost_usd: u.cost,
			}
		: undefined;
	return {
		bytes,
		...(parsed.data.model ? { effective_model: parsed.data.model } : {}),
		...(usage ? { usage } : {}),
	};
}
