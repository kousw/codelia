import type { ContentPart } from "../types/llm/content";

export type StringifyContentMode = "display" | "log";

export type StringifyContentOptions = {
	mode?: StringifyContentMode;
	joiner?: string;
	includeOtherPayload?: boolean;
};

const stringifyUnknown = (value: unknown): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const stringifyPart = (
	part: ContentPart,
	options: Required<StringifyContentOptions>,
): string => {
	if (part.type === "text") {
		return part.text;
	}
	if (part.type === "image_url") {
		if (options.mode === "log") {
			return `[image:${part.image_url.media_type ?? "unknown"}]`;
		}
		return "[image]";
	}
	if (part.type === "document") {
		if (options.mode === "log") {
			return "[document:application/pdf]";
		}
		return "[document]";
	}
	if (part.type === "other") {
		const head = `[other:${part.provider}/${part.kind}]`;
		if (options.mode === "log" && options.includeOtherPayload) {
			return `${head} ${stringifyUnknown(part.payload)}`;
		}
		return head;
	}
	return "[content]";
};

export const stringifyContentParts = (
	content: ContentPart[],
	options: StringifyContentOptions = {},
): string => {
	const normalized: Required<StringifyContentOptions> = {
		mode: options.mode ?? "display",
		joiner: options.joiner ?? (options.mode === "log" ? "\n" : ""),
		includeOtherPayload: options.includeOtherPayload ?? false,
	};
	const text = content
		.map((part) => stringifyPart(part, normalized))
		.join(normalized.joiner);
	return text || stringifyUnknown(content);
};

export const stringifyContent = (
	content: string | ContentPart[] | null | undefined,
	options: StringifyContentOptions = {},
): string => {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return stringifyContentParts(content, options);
};
