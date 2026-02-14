import type { ContentPart } from "@codelia/core";
import type {
	RunInput,
	RunInputImagePart,
	RunInputTextPart,
} from "@codelia/protocol";
import { prepareRunInputText } from "./skill-mentions";

export type NormalizedRunInput = string | ContentPart[];

const isRunInputImageMediaType = (
	value: unknown,
): value is NonNullable<RunInputImagePart["image_url"]["media_type"]> =>
	value === "image/png" ||
	value === "image/jpeg" ||
	value === "image/webp" ||
	value === "image/gif";

const isRunInputImageDetail = (
	value: unknown,
): value is NonNullable<RunInputImagePart["image_url"]["detail"]> =>
	value === "auto" || value === "low" || value === "high";

const normalizeRunInputTextPart = (part: RunInputTextPart): ContentPart => {
	if (typeof part.text !== "string") {
		throw new Error("run.start input.parts[text].text must be a string");
	}
	return {
		type: "text",
		text: prepareRunInputText(part.text),
	};
};

const normalizeRunInputImagePart = (part: RunInputImagePart): ContentPart => {
	const imageUrl = part.image_url;
	if (!imageUrl || typeof imageUrl !== "object") {
		throw new Error("run.start input.parts[image_url].image_url is required");
	}
	if (typeof imageUrl.url !== "string" || imageUrl.url.length === 0) {
		throw new Error(
			"run.start input.parts[image_url].image_url.url must be a non-empty string",
		);
	}
	if (
		imageUrl.media_type !== undefined &&
		!isRunInputImageMediaType(imageUrl.media_type)
	) {
		throw new Error(
			"run.start input.parts[image_url].image_url.media_type must be png/jpeg/webp/gif",
		);
	}
	if (
		imageUrl.detail !== undefined &&
		!isRunInputImageDetail(imageUrl.detail)
	) {
		throw new Error(
			"run.start input.parts[image_url].image_url.detail must be auto/low/high",
		);
	}
	return {
		type: "image_url",
		image_url: {
			url: imageUrl.url,
			...(imageUrl.media_type ? { media_type: imageUrl.media_type } : {}),
			...(imageUrl.detail ? { detail: imageUrl.detail } : {}),
		},
	};
};

export const normalizeRunInput = (input: RunInput): NormalizedRunInput => {
	if (input.type === "text") {
		if (typeof input.text !== "string") {
			throw new Error("run.start input.text must be a string");
		}
		return prepareRunInputText(input.text);
	}

	if (!Array.isArray(input.parts)) {
		throw new Error("run.start input.parts must be an array");
	}
	return input.parts.map((part) => {
		if (!part || typeof part !== "object") {
			throw new Error("run.start input.parts entry must be an object");
		}
		if (part.type === "text") {
			return normalizeRunInputTextPart(part);
		}
		if (part.type === "image_url") {
			return normalizeRunInputImagePart(part);
		}
		throw new Error(
			`run.start input.parts type is not supported: ${String((part as { type?: unknown }).type)}`,
		);
	});
};

export const runInputLengthForDebug = (input: NormalizedRunInput): number => {
	if (typeof input === "string") {
		return input.length;
	}
	let total = 0;
	for (const part of input) {
		if (part.type === "text") {
			total += part.text.length;
			continue;
		}
		if (part.type === "image_url") {
			total += part.image_url.url.length;
		}
	}
	return total;
};
