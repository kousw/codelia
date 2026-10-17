import OpenAI from "openai";
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { OpenAiResponseAccumulator } from "./response-accumulator";
import { createProviderValidationError } from "../failures";
import {
	isCodexBackend,
	type CodexMetadataCollector,
	type CodexTurnState,
} from "./codex-metadata";

export type OpenAiHttpEventObserver = (
	event: ResponseStreamEvent,
) => void | Promise<void>;

export const invokeOpenAiHttp = async (
	client: OpenAI,
	request: ResponseCreateParamsBase,
	signal?: AbortSignal,
	sessionIdHeader?: string,
	onEvent?: OpenAiHttpEventObserver,
	codex?: { routing?: CodexTurnState; metadata: CodexMetadataCollector },
): Promise<Response> => {
	const streamRequest: ResponseCreateParamsStreaming = {
		...request,
		stream: true,
	};
	const options =
		signal || sessionIdHeader
			? {
					...(signal ? { signal } : {}),
					...(sessionIdHeader
						? {
								headers: {
									session_id: sessionIdHeader,
								},
							}
						: {}),
				}
			: undefined;
	if (isCodexBackend(client.baseURL)) {
		codex?.metadata.beginAttempt();
		// Codex emits extensions outside the public Responses event contract.
		// Keep SDK HTTP/SSE/auth/cancellation, bypass only its strict accumulator.
		// Inject routing only after the SDK resolves bearer auth. Never mutate a
		// shared client fetch, and keep the routing token out of request bodies/logs.
		const sourceFetch = (
			client as unknown as { fetch: typeof globalThis.fetch }
		).fetch;
		let ownershipError:
			| ReturnType<typeof createProviderValidationError>
			| undefined;
		const requestClient = codex
			? client.withOptions({
					fetch: async (input, init) => {
						const headers = new Headers(init?.headers);
						if (codex.routing?.bindAuth(headers)) {
							ownershipError = createProviderValidationError(
								"openai",
								"OpenAI authentication changed; start a new run",
							);
							throw ownershipError;
						}
						for (const [key, value] of Object.entries(
							codex.routing?.requestHeaders() ?? {},
						))
							headers.set(key, value);
						const response = await sourceFetch(input, { ...init, headers });
						codex.metadata.observeHeaders(response.headers);
						return response;
					},
				})
			: client;
		const stream = await requestClient.responses
			.create(streamRequest, options)
			.catch((error: unknown) => {
				// SDK wraps custom-fetch exceptions as connection failures. Preserve
				// our non-retryable guard so Agent cannot retry a changed auth owner.
				throw ownershipError ?? error;
			});
		const accumulator = new OpenAiResponseAccumulator();
		for await (const event of stream) {
			if (signal?.aborted) throw new OpenAI.APIUserAbortError();
			codex?.metadata.observeEvent(event);
			await onEvent?.(event);
			if (signal?.aborted) throw new OpenAI.APIUserAbortError();
			if (event.type === "response.failed") {
				throw event.response.error ?? new Error("OpenAI stream failed");
			}
			if (event.type === "error") throw event;
			accumulator.observeEvent(event);
			if (
				event.type === "response.completed" ||
				event.type === "response.incomplete"
			) {
				return accumulator.buildResponse(event.response);
			}
		}
		// The raw SDK iterator can end quietly on abort; preserve cancellation.
		if (signal?.aborted) throw new OpenAI.APIUserAbortError();
		throw new Error("OpenAI stream ended without a terminal response");
	}
	const stream = client.responses.stream(streamRequest, options);
	if (
		typeof (stream as AsyncIterable<ResponseStreamEvent>)[
			Symbol.asyncIterator
		] === "function"
	) {
		const accumulator = new OpenAiResponseAccumulator();
		for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
			accumulator.observeEvent(event);
			await onEvent?.(event);
		}
		const finalResponse = await stream.finalResponse();
		return accumulator.buildResponse(finalResponse);
	}
	return stream.finalResponse();
};
