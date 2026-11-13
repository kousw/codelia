export type DecisionFetch = (
	url: string,
	init?: RequestInit,
) => Promise<Response>;
export class DecisionError extends Error {}

/** Fixed provider origins only; no redirects, retries, raw error bodies or secrets. */
export async function decisionJson(
	url: string,
	init: RequestInit,
	fetcher: DecisionFetch,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(30_000);
	const signal = init.signal
		? AbortSignal.any([init.signal, timeout])
		: timeout;
	const maxBytes = 2 * 1024 * 1024;
	try {
		const response = await fetcher(url, { ...init, signal, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel();
			throw new DecisionError(
				`Decisions API request failed (HTTP ${response.status}); no retry or provider fallback was attempted.`,
			);
		}
		if (
			!response.body ||
			Number(response.headers.get("content-length") ?? 0) > maxBytes
		) {
			await response.body?.cancel();
			throw new DecisionError(
				"Decisions API response was empty or exceeded 2 MiB.",
			);
		}
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		const cancel = () => {
			void reader.cancel().catch(() => {
				/* Preserve the original abort. */
			});
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			while (true) {
				signal.throwIfAborted();
				const item = await reader.read();
				signal.throwIfAborted();
				if (item.done) break;
				size += item.value.length;
				if (size > maxBytes)
					throw new DecisionError("Decisions API response exceeded 2 MiB.");
				chunks.push(item.value);
			}
		} finally {
			signal.removeEventListener("abort", cancel);
			await reader.cancel().catch(() => {
				/* Preserve the request result or failure. */
			});
			reader.releaseLock();
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch (error) {
		if (init.signal?.aborted)
			throw new DecisionError(
				"Decisions request was cancelled; the provider may have billed it. No retry was attempted.",
			);
		if (timeout.aborted)
			throw new DecisionError(
				"Decisions request timed out; the provider may have billed it. No retry was attempted.",
			);
		if (error instanceof DecisionError) throw error;
		throw new DecisionError(
			"Decisions API transport or response failed; no retry or provider fallback was attempted.",
		);
	}
}
