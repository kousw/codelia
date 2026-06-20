import { safeJsonStringify } from "../provider-log";
import {
	appendZaiChatCompletionChunk,
	createZaiStreamAccumulator,
	type ZaiChatCompletionChunk,
	type ZaiChatMessage,
	type ZaiStreamAccumulator,
	type ZaiTool,
	type ZaiToolChoice,
} from "./serializer";

export type ZaiReasoningEffort = "high" | "max";

export type ZaiChatCompletionRequest = {
	model: string;
	messages: ZaiChatMessage[];
	stream: true;
	tools?: ZaiTool[];
	tool_choice?: ZaiToolChoice;
	tool_stream?: true;
	thinking: { type: "enabled" };
	reasoning_effort?: ZaiReasoningEffort;
	[key: string]: unknown;
};

export type ZaiStreamTerminalResponse = {
	status: number;
	request_id?: string | null;
	accumulated: ZaiStreamAccumulator;
};

export type StreamZaiChatCompletionOptions = {
	apiKey: string;
	baseURL: string;
	fetchImpl: typeof fetch;
	request: ZaiChatCompletionRequest;
	signal?: AbortSignal;
	timeoutMs: number | null;
	captureRawChunks?: boolean;
};

export const streamZaiChatCompletion = async ({
	apiKey,
	baseURL,
	fetchImpl,
	request,
	signal,
	timeoutMs,
	captureRawChunks,
}: StreamZaiChatCompletionOptions): Promise<ZaiStreamTerminalResponse> => {
	const requestSignal = createZaiRequestSignal(signal, timeoutMs);
	try {
		const response = await fetchImpl(`${baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: safeJsonStringify(request),
			signal: requestSignal.signal,
		});
		if (!response.ok) {
			throw await toZaiHttpError(response);
		}
		const accumulated = createZaiStreamAccumulator({
			captureRawChunks: captureRawChunks ?? false,
		});
		for await (const chunk of readZaiChatCompletionStream(
			response,
			requestSignal.signal,
		)) {
			appendZaiChatCompletionChunk(accumulated, chunk);
		}
		return {
			status: response.status,
			request_id: response.headers.get("x-request-id"),
			accumulated,
		};
	} finally {
		requestSignal.cleanup();
	}
};

export async function* readZaiChatCompletionStream(
	response: Response,
	signal?: AbortSignal,
): AsyncIterable<ZaiChatCompletionChunk> {
	if (!response.body) {
		throw new Error("Z.ai provider error: response body is empty");
	}
	const reader = response.body.getReader();
	throwIfAborted(signal);
	const cancelOnAbort = () => {
		void reader.cancel(signal?.reason).catch(() => undefined);
	};
	signal?.addEventListener("abort", cancelOnAbort, { once: true });
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			throwIfAborted(signal);
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				const chunk = parseSseDataLine(line);
				if (chunk === "done") {
					return;
				}
				if (chunk) {
					yield chunk;
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
		buffer += decoder.decode();
		const trailing = buffer.trim();
		if (trailing) {
			const chunk = parseSseDataLine(trailing);
			if (chunk && chunk !== "done") {
				yield chunk;
			}
		}
	} finally {
		signal?.removeEventListener("abort", cancelOnAbort);
		reader.releaseLock();
	}
}

export const createZaiRequestSignal = (
	signal: AbortSignal | undefined,
	timeoutMs: number | null,
): { signal?: AbortSignal; cleanup: () => void } => {
	if (!timeoutMs || timeoutMs <= 0) {
		return { signal, cleanup: () => undefined };
	}
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
		controller.abort(new Error("Z.ai request timeout"));
	}, timeoutMs);
	const onAbort = () => {
		controller.abort(signal?.reason);
	};
	if (signal?.aborted) {
		onAbort();
	} else {
		signal?.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			signal?.removeEventListener("abort", onAbort);
		},
	};
};

const toZaiHttpError = async (response: Response): Promise<Error> => {
	let body = "";
	try {
		body = await response.text();
	} catch {
		body = "";
	}
	const snippet = body ? body.slice(0, 500) : "(empty)";
	const prefix =
		response.status === 401 || response.status === 403
			? "Z.ai auth/config error"
			: response.status === 402
				? "Z.ai credits/payment error"
				: response.status === 408 ||
						response.status === 429 ||
						response.status >= 500
					? "Z.ai transient/rate-limit error"
					: "Z.ai provider error";
	return new Error(`${prefix} (${response.status}): ${snippet}`);
};

const throwIfAborted = (signal?: AbortSignal): void => {
	if (!signal?.aborted) {
		return;
	}
	const reason = signal.reason;
	if (reason instanceof Error) {
		throw reason;
	}
	throw new Error("Z.ai request aborted");
};

const parseSseDataLine = (
	line: string,
): ZaiChatCompletionChunk | "done" | null => {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith(":")) {
		return null;
	}
	if (!trimmed.startsWith("data:")) {
		return null;
	}
	const data = trimmed.slice("data:".length).trim();
	if (!data) {
		return null;
	}
	if (data === "[DONE]") {
		return "done";
	}
	try {
		return JSON.parse(data) as ZaiChatCompletionChunk;
	} catch {
		throw new Error(`Malformed Z.ai stream chunk: ${data.slice(0, 300)}`);
	}
};
