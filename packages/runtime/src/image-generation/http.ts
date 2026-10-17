export type ImageFetch = (url: string, init?: RequestInit) => Promise<Response>;
export class ImageGenerationError extends Error {}

/** Fixed origins are supplied by adapters; redirects and automatic paid retries are forbidden. */
export async function imageJson(
	url: string,
	init: RequestInit,
	fetcher: ImageFetch = fetch,
	maxBytes = 12 * 1024 * 1024,
	timeoutMs = 180_000,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal
		? AbortSignal.any([init.signal, timeout])
		: timeout;
	try {
		const response = await fetcher(url, { ...init, signal, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel();
			throw new ImageGenerationError(
				`Image API request failed (HTTP ${response.status}); no fallback or automatic retry was attempted.`,
			);
		}
		if (
			!response.body ||
			Number(response.headers.get("content-length") ?? 0) > maxBytes
		) {
			await response.body?.cancel();
			throw new ImageGenerationError(
				"Image API response exceeded the size limit or was empty.",
			);
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		// Cancel the reader too: custom fetch adapters may not propagate request aborts.
		const cancelReader = () => {
			void reader.cancel().catch(() => {
				/* Preserve the request error if stream cleanup fails. */
			});
		};
		signal.addEventListener("abort", cancelReader, { once: true });
		try {
			while (true) {
				signal.throwIfAborted();
				const chunk = await reader.read();
				signal.throwIfAborted();
				if (chunk.done) break;
				size += chunk.value.length;
				if (size > maxBytes)
					throw new ImageGenerationError(
						"Image API response exceeded the size limit.",
					);
				chunks.push(chunk.value);
			}
		} finally {
			signal.removeEventListener("abort", cancelReader);
			await reader.cancel().catch(() => {
				/* Preserve the request error if stream cleanup fails. */
			});
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch (error) {
		if (init.signal?.aborted)
			throw new ImageGenerationError(
				"Image request cancelled; the provider may already have charged for generation. No retry was attempted.",
			);
		if (timeout.aborted)
			throw new ImageGenerationError(
				"Image request timed out; the provider may already have charged for generation. No retry was attempted.",
			);
		if (error instanceof ImageGenerationError) throw error;
		throw new ImageGenerationError(
			"Image API transport or response failed; no fallback or automatic retry was attempted.",
		);
	}
}
