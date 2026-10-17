import { randomUUID } from "node:crypto";
import { OPENAI_OAUTH_BASE_URL } from "../auth/openai-oauth";
import { type ImageFetch, ImageGenerationError, imageJson } from "./http";
import { type ImageReference, imageReferenceDataUrl } from "./references";
import type { CodexImageToken, ImageRoute } from "./route";

/** Codex's standalone JSON image API, not public Image API or a hosted chat tool. */
export async function requestCodexImage(
	route: Extract<ImageRoute, { authMode: "codex_oauth" }>,
	prompt: string,
	references: ImageReference[],
	signal: AbortSignal | undefined,
	fetcher: ImageFetch,
): Promise<unknown> {
	if (route.endpoint !== `${OPENAI_OAUTH_BASE_URL}/images/generations`)
		throw new ImageGenerationError(
			"Invalid Codex image endpoint; OAuth was not sent.",
		);
	signal?.throwIfAborted();
	let credentials: CodexImageToken;
	try {
		credentials = await route.getAccessToken();
	} catch {
		throw new ImageGenerationError(
			"Codex OAuth authentication/refresh failed; sign in to OpenAI again. No image request or API-key fallback was attempted.",
		);
	}
	signal?.throwIfAborted();
	if (!credentials.token.trim())
		throw new ImageGenerationError(
			"Codex OAuth login is missing; sign in to OpenAI again. An API key is not required.",
		);
	if (route.accountId && credentials.accountId !== route.accountId)
		throw new ImageGenerationError(
			"The Codex OAuth account changed; start a new run before generating images. No request was sent to another account.",
		);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credentials.token}`,
		"Content-Type": "application/json",
		originator: "codelia",
		"User-Agent": "codelia-cli",
		"x-codex-image-turn-id": `codelia-image-${randomUUID()}`,
		...(credentials.accountId
			? { "ChatGPT-Account-ID": credentials.accountId }
			: {}),
	};
	// Follow Codex's typed request. In particular, edits are JSON and output_format
	// is not part of this route's contract; saved output is validated as PNG later.
	const body = {
		model: route.model,
		prompt,
		background: "auto",
		quality: route.options.quality ?? "auto",
		size: route.options.size ?? "auto",
		...(references.length
			? {
					images: references.map((reference) => ({
						image_url: imageReferenceDataUrl(reference),
					})),
				}
			: {}),
	};
	return imageJson(
		`${OPENAI_OAUTH_BASE_URL}/images/${references.length ? "edits" : "generations"}`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		},
		fetcher,
	);
}
