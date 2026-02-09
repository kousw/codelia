import type { ChatMessage } from "../../shared/types";

type HistoryToolCall = {
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
};

export type HistoryMessage = {
	role?: string;
	content?: unknown;
	tool_calls?: HistoryToolCall[];
	tool_call_id?: string;
	tool_name?: string;
	is_error?: boolean;
};

const contentToString = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part: unknown) => {
				if (!part || typeof part !== "object") return "[part]";
				const entry = part as {
					type?: string;
					text?: string;
					provider?: string;
					kind?: string;
				};
				if (entry.type === "text") return entry.text ?? "";
				if (entry.type === "image_url") return "[image]";
				if (entry.type === "document") return "[document]";
				if (entry.type === "other") {
					return `[other:${entry.provider ?? "unknown"}/${entry.kind ?? "unknown"}]`;
				}
				return `[${entry.type ?? "part"}]`;
			})
			.join("");
	}
	return String(content ?? "");
};

const parseToolArgs = (raw: string | undefined): Record<string, unknown> => {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return { _value: parsed };
	} catch {
		return { _raw: raw };
	}
};

export const restoreMessagesFromHistory = (
	history: HistoryMessage[],
	createId: () => string,
	now: () => number = Date.now,
): ChatMessage[] => {
	if (!history.length) return [];
	const restored: ChatMessage[] = [];
	let tick = now();
	let currentAssistant: ChatMessage | null = null;

	const nextTs = () => ++tick;
	const ensureAssistant = (): ChatMessage => {
		if (currentAssistant) return currentAssistant;
		currentAssistant = {
			id: createId(),
			role: "assistant",
			content: "",
			events: [],
			timestamp: nextTs(),
		};
		restored.push(currentAssistant);
		return currentAssistant;
	};

	for (const raw of history) {
		const role = raw?.role;
		if (role === "system") continue;

		if (role === "user") {
			currentAssistant = null;
			restored.push({
				id: createId(),
				role: "user",
				content: contentToString(raw.content),
				events: [],
				timestamp: nextTs(),
			});
			continue;
		}

		if (role === "reasoning") {
			const text = contentToString(raw.content);
			if (!text) continue;
			const assistant = ensureAssistant();
			assistant.events.push({
				type: "reasoning",
				content: text,
				timestamp: nextTs(),
			});
			continue;
		}

		if (role === "assistant") {
			const text = contentToString(raw.content);
			const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
			if (!text && toolCalls.length === 0) continue;

			const assistant = ensureAssistant();
			if (text) {
				assistant.events.push({
					type: "text",
					content: text,
					timestamp: nextTs(),
				});
				assistant.content = assistant.content
					? `${assistant.content}\n${text}`
					: text;
			}
			for (const call of toolCalls) {
				const toolCallId = call.id ?? `tool-call-${createId()}`;
				assistant.events.push({
					type: "tool_call",
					tool: call.function?.name ?? "unknown_tool",
					args: parseToolArgs(call.function?.arguments),
					tool_call_id: toolCallId,
				});
			}
			continue;
		}

		if (role === "tool") {
			const assistant = ensureAssistant();
			const toolCallId = raw.tool_call_id ?? `tool-result-${createId()}`;
			assistant.events.push({
				type: "tool_result",
				tool: raw.tool_name ?? "tool",
				result: contentToString(raw.content),
				tool_call_id: toolCallId,
				is_error: Boolean(raw.is_error),
			});
		}
	}

	return restored.filter(
		(message) =>
			message.role === "user" ||
			message.content.trim().length > 0 ||
			message.events.length > 0,
	);
};
