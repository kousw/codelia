import type OpenAI from "openai";
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { OpenAiResponseAccumulator } from "./response-accumulator";

export type OpenAiHttpEventObserver = (
	event: ResponseStreamEvent,
) => void | Promise<void>;

export const invokeOpenAiHttp = async (
	client: OpenAI,
	request: ResponseCreateParamsBase,
	signal?: AbortSignal,
	sessionIdHeader?: string,
	onEvent?: OpenAiHttpEventObserver,
): Promise<Response> => {
	const streamRequest: ResponseCreateParamsStreaming = {
		...request,
		stream: true,
	};
	const stream = client.responses.stream(
		streamRequest,
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
			: undefined,
	);
	if (
		typeof (stream as AsyncIterable<ResponseStreamEvent>)[Symbol.asyncIterator] ===
		"function"
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
