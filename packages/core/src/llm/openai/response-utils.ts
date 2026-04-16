import type {
	Response,
	ResponseFunctionCallOutputItemList,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ChatInvokeCompletion, ContentPart } from "../../types/llm";

type OtherPart = Extract<ContentPart, { type: "other" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const stringifyUnknown = (value: unknown): string => {
	if (value == null) return "";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const formatOtherPart = (part: OtherPart): string => {
	const payloadText = stringifyUnknown(part.payload);
	return payloadText
		? `[other:${part.provider}/${part.kind}] ${payloadText}`
		: `[other:${part.provider}/${part.kind}]`;
};

const isOpenAiInputContent = (
	value: unknown,
): value is ResponseInputContent => {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (type === "input_text") {
		return typeof value.text === "string";
	}
	if (type === "input_image") {
		return typeof value.image_url === "string";
	}
	if (type === "input_file") {
		return (
			typeof value.file_data === "string" || typeof value.file_id === "string"
		);
	}
	return false;
};

export const sanitizeResponseOutputItems = (
	items: ResponseOutputItem[],
): ResponseInputItem[] =>
	items.map((item) => {
		if (item.type === "function_call") {
			const { parsed_arguments: _parsed, ...rest } = item as {
				parsed_arguments?: unknown;
			};
			return rest as ResponseInputItem;
		}
		if (item.type === "message") {
			const content = item.content?.map((part) => {
				if (part && typeof part === "object" && "parsed" in part) {
					const { parsed: _parsed, ...rest } = part as {
						parsed?: unknown;
					};
					return rest;
				}
				return part;
			});
			return { ...item, content } as ResponseInputItem;
		}
		return item as ResponseInputItem;
	});

export const extractOutputText = (items: ResponseOutputItem[]): string => {
	const texts: string[] = [];
	for (const item of items) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text") {
				texts.push(part.text);
			}
		}
	}
	return texts.join("");
};

export type EmptyCompletionDebugPayload = {
	id: string;
	status: string | null;
	output_text: string | null;
	output: ResponseOutputItem[];
	usage: Response["usage"] | null;
};

export type ResponseStreamEventDebugPayload = {
	type: string;
	sequence_number: number | null;
	output_index?: number;
	content_index?: number;
	item_type?: string;
	item_role?: string;
	part_type?: string;
	delta_chars?: number;
	delta_preview?: string;
	response_id?: string;
	response_status?: string | null;
	response_output_items?: number;
	response_output_text?: string | null;
	response_output_tokens?: number;
	response_reasoning_tokens?: number;
};

const getRecordString = (
	record: Record<string, unknown>,
	key: string,
): string | undefined => {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
};

const getRecordNumber = (
	record: Record<string, unknown>,
	key: string,
): number | undefined => {
	const value = record[key];
	return typeof value === "number" ? value : undefined;
};

const clipDebugText = (value: string, maxChars = 80): string =>
	value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;

export const getResponseStreamEventDebugPayload = (
	event: ResponseStreamEvent,
): ResponseStreamEventDebugPayload => {
	const payload: ResponseStreamEventDebugPayload = {
		type: event.type,
		sequence_number:
			typeof event.sequence_number === "number" ? event.sequence_number : null,
	};
	const eventRecord = event as unknown as Record<string, unknown>;
	const outputIndex = getRecordNumber(eventRecord, "output_index");
	if (outputIndex !== undefined) {
		payload.output_index = outputIndex;
	}
	const contentIndex = getRecordNumber(eventRecord, "content_index");
	if (contentIndex !== undefined) {
		payload.content_index = contentIndex;
	}
	switch (event.type) {
		case "response.output_text.delta":
		case "response.reasoning_text.delta":
		case "response.function_call_arguments.delta": {
			const delta = getRecordString(eventRecord, "delta") ?? "";
			payload.delta_chars = delta.length;
			payload.delta_preview = clipDebugText(delta);
			break;
		}
		case "response.output_item.added":
		case "response.output_item.done": {
			const item = eventRecord.item;
			if (isRecord(item)) {
				payload.item_type = getRecordString(item, "type");
				payload.item_role = getRecordString(item, "role");
			}
			break;
		}
		case "response.content_part.added": {
			const part = eventRecord.part;
			if (isRecord(part)) {
				payload.part_type = getRecordString(part, "type");
				if (part.type === "output_text") {
					const text = getRecordString(part, "text") ?? "";
					payload.delta_chars = text.length;
					payload.delta_preview = clipDebugText(text);
				}
			}
			break;
		}
		case "response.completed": {
			const response = eventRecord.response;
			if (isRecord(response)) {
				payload.response_id = getRecordString(response, "id");
				const status = response.status;
				payload.response_status = typeof status === "string" ? status : null;
				const output = response.output;
				if (Array.isArray(output)) {
					payload.response_output_items = output.length;
				}
				const outputText = response.output_text;
				payload.response_output_text =
					typeof outputText === "string" ? clipDebugText(outputText) : null;
				const usage = response.usage;
				if (isRecord(usage)) {
					payload.response_output_tokens = getRecordNumber(
						usage,
						"output_tokens",
					);
					const outputDetails = usage.output_tokens_details;
					if (isRecord(outputDetails)) {
						payload.response_reasoning_tokens = getRecordNumber(
							outputDetails,
							"reasoning_tokens",
						);
					}
				}
			}
			break;
		}
	}
	return payload;
};

export const getEmptyCompletionDebugPayload = (
	response: Response,
	completion: ChatInvokeCompletion,
): EmptyCompletionDebugPayload | null => {
	if (completion.messages.length > 0) {
		return null;
	}
	const outputTokens = response.usage?.output_tokens;
	if (typeof outputTokens !== "number" || outputTokens <= 0) {
		return null;
	}
	return {
		id: response.id,
		status: response.status ?? null,
		output_text:
			typeof response.output_text === "string" ? response.output_text : null,
		output: Array.isArray(response.output) ? response.output : [],
		usage: response.usage ?? null,
	};
};

export const toResponseInputContent = (
	part: ContentPart,
): ResponseInputContent => {
	switch (part.type) {
		case "text":
			return { type: "input_text", text: part.text };
		case "image_url":
			return {
				type: "input_image",
				image_url: part.image_url.url,
				detail: part.image_url.detail ?? "auto",
			};
		case "document":
			return {
				type: "input_file",
				file_data: part.source.data,
				filename: "document.pdf",
			};
		case "other":
			if (part.provider === "openai" && isOpenAiInputContent(part.payload)) {
				return part.payload;
			}
			return { type: "input_text", text: formatOtherPart(part) };
		default:
			return { type: "input_text", text: "" };
	}
};

export const toResponseInputContents = (
	content: string | ContentPart[] | null,
): string | ResponseInputContent[] => {
	if (content == null) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content.map(toResponseInputContent);
};

export const toFunctionCallOutput = (
	content: string | ContentPart[],
): string | ResponseFunctionCallOutputItemList => {
	if (typeof content === "string") {
		return content;
	}
	return content.map(toResponseInputContent);
};
