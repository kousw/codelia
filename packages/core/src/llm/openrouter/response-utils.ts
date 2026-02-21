import type {
	ResponseFunctionCallOutputItemList,
	ResponseInputContent,
	ResponseInputItem,
	ResponseOutputItem,
} from "openai/resources/responses/responses";
import type { ContentPart } from "../../types/llm";

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

const isResponsesApiInputContent = (
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

const isOpenRouterReplayableOtherPart = (
	part: OtherPart,
): part is OtherPart & { payload: ResponseInputContent } =>
	(part.provider === "openrouter" || part.provider === "openai") &&
	isResponsesApiInputContent(part.payload);

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
			if (isOpenRouterReplayableOtherPart(part)) {
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
