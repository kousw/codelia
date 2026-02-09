import {
	createParser,
	type EventSourceMessage,
	type ParseError,
} from "eventsource-parser";
import { describeError, isRecord } from "./jsonrpc";

const isEventStreamResponse = (response: Response): boolean => {
	const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
	return contentType.includes("text/event-stream");
};

const parseSsePayload = (event: EventSourceMessage): unknown | undefined => {
	const payload = event.data.trim();
	if (!payload || payload === "[DONE]") return undefined;
	try {
		return JSON.parse(payload) as unknown;
	} catch (error) {
		// Streamable HTTP can include control events such as `endpoint` with plain text payload.
		if (event.event && event.event !== "message") {
			return undefined;
		}
		throw new Error(
			`Invalid MCP HTTP event payload JSON: ${describeError(error)}`,
		);
	}
};

const matchesRequestId = (
	value: unknown,
	expectedRequestId: string,
): boolean => {
	if (Array.isArray(value)) {
		return value.some((entry) => matchesRequestId(entry, expectedRequestId));
	}
	if (!isRecord(value)) return false;
	const id = value.id;
	return typeof id === "string" || typeof id === "number"
		? String(id) === expectedRequestId
		: false;
};

const readSseBody = async (
	response: Response,
	expectedRequestId?: string,
): Promise<unknown> => {
	if (!expectedRequestId) {
		// Notifications don't require parsing a response body.
		return null;
	}
	const body = response.body;
	if (!body) return null;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const messages: unknown[] = [];
	let parseFailure: Error | undefined;
	let hasMatched = false;
	let matchedValue: unknown;
	const parser = createParser({
		onEvent: (event) => {
			if (parseFailure || hasMatched) return;
			try {
				const parsed = parseSsePayload(event);
				if (parsed === undefined) return;
				if (matchesRequestId(parsed, expectedRequestId)) {
					hasMatched = true;
					matchedValue = parsed;
					return;
				}
				messages.push(parsed);
			} catch (error) {
				parseFailure =
					error instanceof Error ? error : new Error(String(error));
			}
		},
		onError: (error: ParseError) => {
			if (parseFailure) return;
			parseFailure = new Error(
				`Invalid MCP HTTP event stream: ${error.message}`,
			);
		},
	});
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			parser.feed(decoder.decode(chunk.value, { stream: true }));
			if (parseFailure) {
				throw parseFailure;
			}
			if (hasMatched) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
		if (!hasMatched) {
			parser.feed(`${decoder.decode()}\n\n`);
			parser.reset();
			if (parseFailure) {
				throw parseFailure;
			}
		}
		if (hasMatched) return matchedValue;
		if (!messages.length) return null;
		return messages.length === 1 ? messages[0] : messages;
	} finally {
		reader.releaseLock();
	}
};

export const readJsonBody = async (
	response: Response,
	expectedRequestId?: string,
): Promise<unknown> => {
	if (isEventStreamResponse(response)) {
		return readSseBody(response, expectedRequestId);
	}
	const text = await response.text();
	if (!text.trim()) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Invalid MCP HTTP response JSON: ${describeError(error)}`);
	}
};
