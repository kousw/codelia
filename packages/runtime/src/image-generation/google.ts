import { GoogleGenAI } from "@google/genai";
import type { GeneratedImageMetadata } from "@codelia/shared-types";
import { IMAGE_MAX_BYTES } from "@codelia/storage";
import { type ImageFetch, ImageGenerationError } from "./http";
import type { ImageReference } from "./references";
import type { ImageRoute } from "./route";

type GoogleImageRoute = ImageRoute & {
	provider: "google";
	authMode: "api_key";
};
const MAX_GOOGLE_RESPONSE_BYTES = 192 * 1024 * 1024;

/** Bound SDK buffering before it parses base64 JSON from a paid response. */
export async function boundedGoogleImageFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
	fetcher: ImageFetch = fetch,
): Promise<Response> {
	const response =
		fetcher === fetch
			? await fetch(input, { ...init, redirect: "error" })
			: await (async () => {
					const request = new Request(input, init);
					return fetcher(request.url, {
						method: request.method,
						headers: request.headers,
						...(request.body ? { body: await request.arrayBuffer() } : {}),
						signal: request.signal,
						redirect: "error",
					});
				})();
	if (!response.ok || !response.body) return response;
	if (
		Number(response.headers.get("content-length") ?? 0) >
		MAX_GOOGLE_RESPONSE_BYTES
	) {
		await response.body.cancel();
		throw new ImageGenerationError(
			"Google image response exceeded the transport limit.",
		);
	}
	const reader = response.body.getReader();
	let bytes = 0;
	const bounded = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await reader.read();
			if (next.done) {
				controller.close();
				return;
			}
			bytes += next.value.byteLength;
			if (bytes > MAX_GOOGLE_RESPONSE_BYTES) {
				await reader.cancel();
				controller.error(
					new ImageGenerationError(
						"Google image response exceeded the transport limit.",
					),
				);
				return;
			}
			controller.enqueue(next.value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(bounded, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
export type GoogleImageResult = {
	images: Array<{ bytes: Buffer; media_type: "image/png" | "image/jpeg" }>;
	effective_model?: string;
	usage?: GeneratedImageMetadata["usage"];
};

/** Parse all final model output blocks; thought images are not deliverables. */
export function parseGoogleImageInteraction(raw: unknown): GoogleImageResult {
	const response = raw as {
		status?: unknown;
		model?: unknown;
		steps?: Array<{
			type?: unknown;
			content?: Array<{ type?: unknown; mime_type?: unknown; data?: unknown }>;
		}>;
		usage?: { total_input_tokens?: unknown; total_output_tokens?: unknown };
	};
	if (response?.status !== "completed" || !Array.isArray(response.steps))
		throw new ImageGenerationError(
			"Google image interaction did not complete.",
		);
	const images: GoogleImageResult["images"] = [];
	for (const step of response.steps) {
		if (step?.type !== "model_output") continue;
		for (const part of step.content ?? []) {
			if (part?.type !== "image") continue;
			if (
				(part.mime_type !== "image/png" && part.mime_type !== "image/jpeg") ||
				typeof part.data !== "string" ||
				part.data.length > Math.ceil((IMAGE_MAX_BYTES / 3) * 4)
			)
				throw new ImageGenerationError(
					"Google returned an unsupported image format or size.",
				);
			const bytes = Buffer.from(part.data, "base64");
			if (
				!bytes.length ||
				bytes.length > IMAGE_MAX_BYTES ||
				bytes.toString("base64") !== part.data
			)
				throw new ImageGenerationError(
					"Google returned malformed image bytes.",
				);
			images.push({ bytes, media_type: part.mime_type });
			if (images.length > 4)
				throw new ImageGenerationError(
					"Google returned too many image outputs.",
				);
		}
	}
	if (!images.length)
		throw new ImageGenerationError("Google returned no final image.");
	const number = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
	const inputTokens = number(response.usage?.total_input_tokens);
	const outputTokens = number(response.usage?.total_output_tokens);
	return {
		images,
		...(typeof response.model === "string"
			? { effective_model: response.model }
			: {}),
		...(inputTokens !== undefined || outputTokens !== undefined
			? {
					usage: {
						...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
						...(outputTokens !== undefined
							? { output_tokens: outputTokens }
							: {}),
					},
				}
			: {}),
	};
}

export async function generateGoogleImage(
	route: GoogleImageRoute,
	prompt: string,
	references: ImageReference[],
	signal?: AbortSignal,
	fetcher: ImageFetch = fetch,
): Promise<GoogleImageResult> {
	const size = route.options.image_size ?? "1K";
	if (route.model === "gemini-3.1-flash-lite-image" && size !== "1K")
		throw new ImageGenerationError("Gemini Flash Lite Image supports 1K only.");
	if (references.length > 14)
		throw new ImageGenerationError(
			"Google image models accept at most 14 references.",
		);
	signal?.throwIfAborted();
	const client = new GoogleGenAI({
		apiKey: route.apiKey,
		httpOptions: {
			fetch: (input, init) => boundedGoogleImageFetch(input, init, fetcher),
		},
	});
	try {
		const response = await client.interactions.create(
			{
				model: route.model,
				store: false,
				automatic_continuation: false,
				input: [
					{ type: "text", text: prompt },
					...references.map((reference) => ({
						type: "image" as const,
						mime_type: reference.media_type,
						data: Buffer.from(reference.bytes).toString("base64"),
					})),
				],
				response_format: {
					type: "image",
					image_size: size,
					...(route.options.aspect_ratio
						? { aspect_ratio: route.options.aspect_ratio }
						: {}),
					...(route.options.output_format === "jpeg"
						? { mime_type: "image/jpeg" }
						: {}),
				},
			},
			{
				...(signal ? { signal } : {}),
				retries: { strategy: "none" },
				timeout_ms: 180_000,
			},
		);
		signal?.throwIfAborted();
		const parsed = parseGoogleImageInteraction(response);
		const requestedMime = route.options.output_format
			? `image/${route.options.output_format}`
			: undefined;
		if (
			requestedMime &&
			parsed.images.some((image) => image.media_type !== requestedMime)
		)
			throw new ImageGenerationError(
				"Google returned an image format different from the requested format; no conversion was performed.",
			);
		return parsed;
	} catch (error) {
		if (error instanceof ImageGenerationError) throw error;
		throw new ImageGenerationError(
			signal?.aborted
				? "Google image request cancelled; usage may have been incurred."
				: "Google image request failed; no fallback or automatic retry was attempted.",
		);
	}
}
