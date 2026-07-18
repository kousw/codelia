import type {
	Tool as OpenAITool,
	Response,
	ResponseInput,
	ToolChoiceFunction,
	ToolChoiceOptions,
} from "openai/resources/responses/responses";
import type {
	BaseMessage,
	ChatInvokeCompletion,
	ContentPart,
	HostedWebSearchToolDefinition,
	HostedXSearchToolDefinition,
	ToolChoice,
	ToolDefinition,
} from "../../types/llm";
import {
	isHostedWebSearchToolDefinition,
	isHostedXSearchToolDefinition,
} from "../../types/llm";
import {
	toChatInvokeCompletion,
	toResponsesInput,
	toResponsesToolChoice,
	toResponsesTools,
} from "../openai/serializer";

const XAI_SUPPORTED_INLINE_IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
]);
const XAI_MAX_WEB_SEARCH_ALLOWED_DOMAINS = 5;
const XAI_MAX_X_SEARCH_HANDLES = 20;

type XaiXSearchTool = {
	type: "x_search";
	allowed_x_handles?: string[];
	excluded_x_handles?: string[];
	from_date?: string;
	to_date?: string;
	enable_image_understanding?: boolean;
	enable_video_understanding?: boolean;
};

type XaiWebSearchTool = {
	type: "web_search";
	filters?: {
		allowed_domains: string[];
	};
};

type XaiXSearchCall = {
	type: "x_search_call";
	id?: string;
	status?: string;
	action?: {
		queries?: unknown;
		sources?: unknown;
	};
	[key: string]: unknown;
};

export type XaiResponsesInput = Array<ResponseInput[number] | XaiXSearchCall>;

const mapOtherPartProvider = (
	part: ContentPart,
	from: "openai" | "xai",
	to: "openai" | "xai",
): ContentPart =>
	part.type === "other" && part.provider === from
		? { ...part, provider: to }
		: part;

const mapMessageOtherParts = (
	message: BaseMessage,
	from: "openai" | "xai",
	to: "openai" | "xai",
): BaseMessage => {
	if (!Array.isArray(message.content)) {
		return message;
	}
	return {
		...message,
		content: message.content.map((part) =>
			mapOtherPartProvider(part, from, to),
		),
	} as BaseMessage;
};

const assertSupportedInlineImage = (part: ContentPart): void => {
	if (part.type !== "image_url") return;
	const declaredMediaType = part.image_url.media_type?.toLowerCase();
	const dataUrlMatch = /^data:([^;,]+)[;,]/i.exec(part.image_url.url);
	const inlineMediaType = dataUrlMatch?.[1]?.toLowerCase();
	const mediaType = inlineMediaType ?? declaredMediaType;
	if (
		part.image_url.url.startsWith("data:") &&
		(!mediaType || !XAI_SUPPORTED_INLINE_IMAGE_MEDIA_TYPES.has(mediaType))
	) {
		throw new Error(
			`xAI image input supports inline image/jpeg and image/png only; received ${mediaType ?? "unknown media type"}`,
		);
	}
};

const assertSupportedImages = (messages: BaseMessage[]): void => {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			assertSupportedInlineImage(part);
		}
	}
};

export const toXaiResponsesInput = (
	messages: BaseMessage[],
): XaiResponsesInput => {
	assertSupportedImages(messages);
	const input: XaiResponsesInput = [];
	for (const message of messages) {
		if (message.role === "reasoning" && isXSearchCall(message.raw_item)) {
			input.push(message.raw_item as never);
			continue;
		}
		input.push(
			...toResponsesInput([mapMessageOtherParts(message, "xai", "openai")]),
		);
	}
	return input;
};

const normalizeXSearchHandles = (
	values: string[] | undefined,
	field: "allowed_x_handles" | "excluded_x_handles",
): string[] | undefined => {
	if (!values?.length) return undefined;
	const normalized = Array.from(
		new Set(values.map((value) => value.trim().replace(/^@/, ""))),
	);
	if (normalized.some((value) => value.length === 0)) {
		throw new Error(`xAI X Search ${field} must not contain empty handles`);
	}
	const invalid = normalized.find((value) => !/^[A-Za-z0-9_]+$/.test(value));
	if (invalid) {
		throw new Error(
			`xAI X Search ${field} must contain bare X handles; received ${invalid}`,
		);
	}
	if (normalized.length > XAI_MAX_X_SEARCH_HANDLES) {
		throw new Error(
			`xAI X Search supports at most ${XAI_MAX_X_SEARCH_HANDLES} ${field}; received ${normalized.length}`,
		);
	}
	return normalized;
};

const isIsoDate = (value: string): boolean => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day
	);
};

const assertXSearchDate = (
	value: string | undefined,
	field: "from_date" | "to_date",
): void => {
	if (value !== undefined && !isIsoDate(value)) {
		throw new Error(
			`xAI X Search ${field} must use a valid YYYY-MM-DD date; received ${value}`,
		);
	}
};

const toXaiXSearchTool = (
	tool: HostedXSearchToolDefinition,
): XaiXSearchTool => {
	const allowedXHandles = normalizeXSearchHandles(
		tool.allowed_x_handles,
		"allowed_x_handles",
	);
	const excludedXHandles = normalizeXSearchHandles(
		tool.excluded_x_handles,
		"excluded_x_handles",
	);
	if (allowedXHandles && excludedXHandles) {
		throw new Error(
			"xAI X Search allowed_x_handles and excluded_x_handles are mutually exclusive",
		);
	}
	assertXSearchDate(tool.from_date, "from_date");
	assertXSearchDate(tool.to_date, "to_date");
	if (tool.from_date && tool.to_date && tool.from_date > tool.to_date) {
		throw new Error("xAI X Search from_date must be on or before to_date");
	}
	return {
		type: "x_search",
		...(allowedXHandles ? { allowed_x_handles: allowedXHandles } : {}),
		...(excludedXHandles ? { excluded_x_handles: excludedXHandles } : {}),
		...(tool.from_date ? { from_date: tool.from_date } : {}),
		...(tool.to_date ? { to_date: tool.to_date } : {}),
		...(typeof tool.enable_image_understanding === "boolean"
			? { enable_image_understanding: tool.enable_image_understanding }
			: {}),
		...(typeof tool.enable_video_understanding === "boolean"
			? { enable_video_understanding: tool.enable_video_understanding }
			: {}),
	};
};

const toXaiWebSearchTool = (
	tool: HostedWebSearchToolDefinition,
): XaiWebSearchTool => {
	if (
		(tool.allowed_domains?.length ?? 0) > XAI_MAX_WEB_SEARCH_ALLOWED_DOMAINS
	) {
		throw new Error(
			`xAI web search supports at most ${XAI_MAX_WEB_SEARCH_ALLOWED_DOMAINS} allowed_domains; received ${tool.allowed_domains?.length ?? 0}`,
		);
	}
	return {
		type: "web_search",
		...(tool.allowed_domains?.length
			? { filters: { allowed_domains: tool.allowed_domains } }
			: {}),
	};
};

export const toXaiResponsesTools = (
	tools?: ToolDefinition[] | null,
): OpenAITool[] | undefined => {
	if (!tools?.length) return undefined;
	const mapped: OpenAITool[] = [];
	for (const tool of tools) {
		if (isHostedXSearchToolDefinition(tool)) {
			mapped.push(toXaiXSearchTool(tool) as unknown as OpenAITool);
			continue;
		}
		if (!isHostedWebSearchToolDefinition(tool) || tool.provider !== "xai") {
			const serialized = toResponsesTools([tool]);
			if (serialized?.[0]) mapped.push(serialized[0]);
			continue;
		}
		mapped.push(toXaiWebSearchTool(tool) as unknown as OpenAITool);
	}
	return mapped.length ? mapped : undefined;
};

export const toXaiResponsesToolChoice = (
	choice?: ToolChoice | null,
): ToolChoiceOptions | ToolChoiceFunction | undefined =>
	toResponsesToolChoice(choice);

export const toXaiChatInvokeCompletion = (
	response: Response,
	meta?: {
		reasoning_requested?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoning_applied?: "low" | "medium" | "high" | "xhigh" | "max";
		reasoning_fallback?: boolean;
	},
): ChatInvokeCompletion => {
	const completion = toChatInvokeCompletion(response, {
		transport: "http_stream",
		...meta,
	});
	const messages = completion.messages.map((message, index) => {
		const item = response.output[index] as unknown;
		if (isXSearchCall(item)) {
			return {
				role: "reasoning" as const,
				content: extractXSearchSummary(item),
				raw_item: item,
			};
		}
		return mapMessageOtherParts(message, "openai", "xai");
	});
	const citations = response.output.flatMap((item) => {
		if (item.type !== "message") return [];
		return item.content.flatMap((part) =>
			part.type === "output_text" && Array.isArray(part.annotations)
				? part.annotations
				: [],
		);
	});
	return {
		...completion,
		messages,
		provider_meta: {
			...(completion.provider_meta as Record<string, unknown>),
			...(citations.length ? { citations } : {}),
		},
	};
};

const isXSearchCall = (value: unknown): value is XaiXSearchCall =>
	Boolean(
		value &&
			typeof value === "object" &&
			(value as Record<string, unknown>).type === "x_search_call",
	);

const extractXSearchSummary = (item: XaiXSearchCall): string => {
	const status = typeof item.status === "string" ? item.status : "completed";
	const parts = [`XSearch status=${status}`];
	const queries = Array.isArray(item.action?.queries)
		? item.action.queries.filter(
				(value): value is string =>
					typeof value === "string" && value.length > 0,
			)
		: [];
	if (queries.length) parts.push(`queries=${queries.join(" | ")}`);
	if (Array.isArray(item.action?.sources)) {
		parts.push(`sources=${item.action.sources.length}`);
	}
	return parts.join(" | ");
};
