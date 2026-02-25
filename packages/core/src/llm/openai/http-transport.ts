import type OpenAI from "openai";
import type {
	Response,
	ResponseCreateParamsBase,
	ResponseCreateParamsStreaming,
} from "openai/resources/responses/responses";

export const invokeOpenAiHttp = async (
	client: OpenAI,
	request: ResponseCreateParamsBase,
	signal?: AbortSignal,
	sessionIdHeader?: string,
): Promise<Response> => {
	const streamRequest: ResponseCreateParamsStreaming = {
		...request,
		stream: true,
	};
	return client.responses
		.stream(
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
		)
		.finalResponse();
};
