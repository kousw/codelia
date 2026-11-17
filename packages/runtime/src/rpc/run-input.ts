import type { ContentPart, ToolChoice } from "@codelia/core";
import type {
	RunInput,
	RunInputImagePart,
	RunInputText,
	RunInputTextPart,
} from "@codelia/protocol";
import { ATTACHMENT_ID_PATTERN } from "@codelia/shared-types";
import type { AttachmentTransferService } from "../attachments/service";
import { ATTACHMENT_READ_TOOL_NAME } from "../tools/attachment-read";
import { prepareRunInputText } from "./skill-mentions";

export type NormalizedRunInput = string | ContentPart[];
type PendingAttachmentPart = { type: "attachment_ref"; attachment_id: string };
export type UnresolvedRunInput =
	| string
	| (ContentPart | PendingAttachmentPart)[];

const isPendingAttachment = (
	part: ContentPart | PendingAttachmentPart,
): part is PendingAttachmentPart =>
	part.type === "attachment_ref" && "attachment_id" in part;

export const runAttachmentIds = (input: UnresolvedRunInput): string[] =>
	typeof input === "string"
		? []
		: input.filter(isPendingAttachment).map((part) => part.attachment_id);

export class AttachmentAdmissionError extends Error {}

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

const normalizeRunInputTextPart = (
	part: RunInputTextPart,
	methodName: string,
): ContentPart => {
	if (typeof part.text !== "string") {
		throw new Error(`${methodName} input.parts[text].text must be a string`);
	}
	return {
		type: "text",
		text: prepareRunInputText(part.text),
	};
};

const normalizeRunInputImagePart = (
	part: RunInputImagePart,
	methodName: string,
): ContentPart => {
	const imageUrl = part.image_url;
	if (!imageUrl || typeof imageUrl !== "object") {
		throw new Error(
			`${methodName} input.parts[image_url].image_url is required`,
		);
	}
	if (typeof imageUrl.url !== "string" || imageUrl.url.length === 0) {
		throw new Error(
			`${methodName} input.parts[image_url].image_url.url must be a non-empty string`,
		);
	}
	if (
		imageUrl.media_type !== undefined &&
		!isRunInputImageMediaType(imageUrl.media_type)
	) {
		throw new Error(
			`${methodName} input.parts[image_url].image_url.media_type must be png/jpeg/webp/gif`,
		);
	}
	if (
		imageUrl.detail !== undefined &&
		!isRunInputImageDetail(imageUrl.detail)
	) {
		throw new Error(
			`${methodName} input.parts[image_url].image_url.detail must be auto/low/high`,
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

export function normalizeRunInput(
	input:
		| RunInputText
		| { type: "parts"; parts: (RunInputTextPart | RunInputImagePart)[] },
	methodName?: string,
): NormalizedRunInput;
export function normalizeRunInput(
	input: RunInput,
	methodName?: string,
): UnresolvedRunInput;
export function normalizeRunInput(
	input: RunInput,
	methodName = "run.start",
): UnresolvedRunInput {
	if (!input || typeof input !== "object") {
		throw new Error(`${methodName} input must be an object`);
	}
	if (input.type === "text") {
		if (typeof input.text !== "string") {
			throw new Error(`${methodName} input.text must be a string`);
		}
		return prepareRunInputText(input.text);
	}
	if (input.type !== "parts") {
		throw new Error(
			`${methodName} input.type is not supported: ${String((input as { type?: unknown }).type)}`,
		);
	}

	if (!Array.isArray(input.parts)) {
		throw new Error(`${methodName} input.parts must be an array`);
	}
	return input.parts.map((part) => {
		if (!part || typeof part !== "object") {
			throw new Error(`${methodName} input.parts entry must be an object`);
		}
		if (part.type === "text") {
			return normalizeRunInputTextPart(part, methodName);
		}
		if (part.type === "image_url") {
			return normalizeRunInputImagePart(part, methodName);
		}
		if (part.type === "attachment_ref") {
			if (
				typeof part.attachment_id !== "string" ||
				!ATTACHMENT_ID_PATTERN.test(part.attachment_id)
			)
				throw new Error(
					`${methodName} input contains an invalid attachment ID`,
				);
			return { type: "attachment_ref", attachment_id: part.attachment_id };
		}
		throw new Error(
			`${methodName} input.parts type is not supported: ${String((part as { type?: unknown }).type)}`,
		);
	});
}

export const isRunInputEmpty = (input: UnresolvedRunInput): boolean => {
	if (typeof input === "string") {
		return input.trim().length === 0;
	}
	if (input.length === 0) {
		return true;
	}
	return input.every(
		(part) => part.type === "text" && part.text.trim().length === 0,
	);
};

type AttachmentAdmission = {
	service?: AttachmentTransferService;
	sessionId: string;
	allowDraft?: boolean;
	canReadAttachment?: (attachmentId: string) => boolean;
	canUseVision: () => boolean;
	canPersistInlineImages: boolean;
	toolChoice?: ToolChoice;
};

export async function resolveRunInputAttachments(
	input: UnresolvedRunInput,
	options: AttachmentAdmission,
): Promise<NormalizedRunInput> {
	if (typeof input === "string") return input;
	const ids = runAttachmentIds(input);
	if (ids.length === 0)
		return input.filter(
			(part): part is ContentPart => !isPendingAttachment(part),
		);
	const { service } = options;
	if (!service)
		throw new AttachmentAdmissionError(
			"File attachments are unavailable on this connection",
		);
	const limits = service.limits;
	const inlineImages = input.filter((part) => part.type === "image_url");
	if (ids.length + inlineImages.length > limits.max_attachments)
		throw new AttachmentAdmissionError(
			`A message can include up to ${limits.max_attachments} attachments`,
		);
	if (inlineImages.length > 0 && !options.canPersistInlineImages)
		throw new AttachmentAdmissionError(
			"This connection cannot persist inline images alongside uploaded files",
		);
	let totalBytes = 0;
	for (const {
		image_url: { url },
	} of inlineImages) {
		const comma = url.indexOf(",");
		if (!url.startsWith("data:image/") || comma < 0)
			throw new AttachmentAdmissionError(
				"Mixed file and image messages require uploaded or inline images with a bounded size",
			);
		const padding = url.endsWith("==") ? 2 : Number(url.endsWith("="));
		const size = Math.floor(((url.length - comma - 1) * 3) / 4) - padding;
		if (size > limits.max_image_bytes)
			throw new AttachmentAdmissionError(
				`An image exceeds the ${limits.max_image_bytes}-byte attachment limit`,
			);
		totalBytes += size;
	}
	let resolved: Awaited<
		ReturnType<AttachmentTransferService["resolveForAdmission"]>
	>;
	try {
		resolved = await service.resolveForAdmission(ids, options.sessionId, {
			allowDraft: options.allowDraft,
		});
	} catch {
		throw new AttachmentAdmissionError(
			"An attachment is unavailable or corrupt. Upload it again for this conversation.",
		);
	}
	const byId = new Map(
		resolved.map((attachment) => [attachment.ref.attachment_id, attachment]),
	);
	const canUseReader =
		!options.toolChoice ||
		["auto", "required", ATTACHMENT_READ_TOOL_NAME].includes(
			options.toolChoice,
		);
	let imageCount = inlineImages.length;
	const output: ContentPart[] = [];
	for (const part of input) {
		if (!isPendingAttachment(part)) {
			output.push(part);
			continue;
		}
		const attachment = byId.get(part.attachment_id);
		if (!attachment)
			throw new AttachmentAdmissionError(
				"An attachment is unavailable or corrupt. Upload it again for this conversation.",
			);
		const { ref, imageRef } = attachment;
		if (imageRef) imageCount++;
		const sizeLimit = imageRef ? limits.max_image_bytes : limits.max_file_bytes;
		if (
			!Number.isSafeInteger(ref.byte_size) ||
			ref.byte_size < 0 ||
			ref.byte_size > sizeLimit
		)
			throw new AttachmentAdmissionError(
				`An attachment exceeds the ${sizeLimit}-byte file limit`,
			);
		totalBytes += ref.byte_size;
		if (
			!imageRef &&
			(!canUseReader || !options.canReadAttachment?.(ref.attachment_id))
		)
			throw new AttachmentAdmissionError(
				"File attachments require attachment_read. The current model or tool policy disables this reader.",
			);
		output.push({
			type: "attachment_ref",
			attachment_ref: ref,
			...(imageRef ? { image_ref: imageRef } : {}),
		});
	}
	if (totalBytes > limits.max_message_bytes)
		throw new AttachmentAdmissionError(
			`Attachments exceed the ${limits.max_message_bytes}-byte message limit`,
		);
	if (imageCount > limits.max_images)
		throw new AttachmentAdmissionError(
			`A message can include up to ${limits.max_images} visual attachments`,
		);
	if (imageCount && !options.canUseVision())
		throw new AttachmentAdmissionError(
			"The selected model or connection has no verified vision input. Select a vision-capable model to send the image.",
		);
	return output;
}

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
