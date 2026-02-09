import type { Agent, BaseMessage } from "@codelia/core";
import { stringifyContent } from "@codelia/core";
import { isDebugEnabled } from "../logger";

const DEBUG_MAX_CONTENT_CHARS = 2_000;
const DEBUG_MAX_LOG_CHARS = 20_000;
const DEBUG_MAX_EVENT_RESULT_CHARS = 500;

const truncateText = (value: string, maxChars: number): string => {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...[truncated]`;
};

const stringifyUnknown = (value: unknown): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const contentToDebugText = (
	content: BaseMessage["content"],
	maxChars: number,
): string => {
	const text = stringifyContent(content, {
		mode: "log",
		joiner: "\n",
		includeOtherPayload: true,
	});
	return truncateText(text, maxChars);
};

const buildCompactionSnapshotLog = (messages: BaseMessage[]): string => {
	const payload = messages.map((message, index) => {
		if (message.role === "assistant") {
			return {
				index,
				role: message.role,
				content: contentToDebugText(message.content, DEBUG_MAX_CONTENT_CHARS),
				tool_calls: (message.tool_calls ?? []).map((call) => ({
					id: call.id,
					name: call.function.name,
				})),
			};
		}
		if (message.role === "tool") {
			return {
				index,
				role: message.role,
				tool_name: message.tool_name,
				tool_call_id: message.tool_call_id,
				is_error: message.is_error ?? false,
				content: contentToDebugText(message.content, DEBUG_MAX_CONTENT_CHARS),
			};
		}
		if (message.role === "reasoning") {
			return {
				index,
				role: message.role,
				content: truncateText(message.content ?? "", DEBUG_MAX_CONTENT_CHARS),
			};
		}
		return {
			index,
			role: message.role,
			content: contentToDebugText(message.content, DEBUG_MAX_CONTENT_CHARS),
		};
	});
	return truncateText(stringifyUnknown(payload), DEBUG_MAX_LOG_CHARS);
};

export const logCompactionSnapshot = (
	log: (message: string) => void,
	runId: string,
	runtimeAgent: Agent,
	compacted: boolean,
): void => {
	if (!isDebugEnabled()) return;
	const messages = runtimeAgent.getHistoryMessages();
	const snapshot = buildCompactionSnapshotLog(messages);
	log(
		`compaction context snapshot run_id=${runId} compacted=${String(compacted)} messages=${messages.length} history=${snapshot}`,
	);
};

export const isTrackedRunEvent = (eventType: string): boolean =>
	eventType === "tool_call" ||
	eventType === "tool_result" ||
	eventType === "step_start" ||
	eventType === "step_complete" ||
	eventType === "final";

export const summarizeRunEvent = (
	event: { type: string } & Record<string, unknown>,
): string => {
	switch (event.type) {
		case "tool_call": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			const toolCallId =
				typeof event.tool_call_id === "string" ? event.tool_call_id : "unknown";
			return `type=tool_call tool=${tool} tool_call_id=${toolCallId}`;
		}
		case "tool_result": {
			const tool = typeof event.tool === "string" ? event.tool : "unknown";
			const toolCallId =
				typeof event.tool_call_id === "string" ? event.tool_call_id : "unknown";
			const isError = event.is_error === true;
			const result =
				typeof event.result === "string"
					? truncateText(event.result, DEBUG_MAX_EVENT_RESULT_CHARS)
					: truncateText(
							stringifyUnknown(event.result),
							DEBUG_MAX_EVENT_RESULT_CHARS,
						);
			return `type=tool_result tool=${tool} tool_call_id=${toolCallId} is_error=${String(isError)} result=${stringifyUnknown(result)}`;
		}
		case "step_start": {
			const stepId =
				typeof event.step_id === "string" ? event.step_id : "unknown";
			const title = typeof event.title === "string" ? event.title : "unknown";
			return `type=step_start step_id=${stepId} title=${title}`;
		}
		case "step_complete": {
			const stepId =
				typeof event.step_id === "string" ? event.step_id : "unknown";
			const status =
				typeof event.status === "string" ? event.status : "unknown";
			const durationMs =
				typeof event.duration_ms === "number" ? event.duration_ms : -1;
			return `type=step_complete step_id=${stepId} status=${status} duration_ms=${durationMs}`;
		}
		case "final": {
			const content = typeof event.content === "string" ? event.content : "";
			return `type=final content_chars=${content.length}`;
		}
		default:
			return `type=${event.type}`;
	}
};

export const logRunDebug = (
	log: (message: string) => void,
	runId: string,
	message: string,
): void => {
	if (!isDebugEnabled()) return;
	log(`run debug run_id=${runId} ${message}`);
};

export const normalizeCancelledHistory = (
	messages: BaseMessage[],
): BaseMessage[] => {
	const assistantCallIds = new Set<string>();
	const toolOutputCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const call of message.tool_calls ?? []) {
				assistantCallIds.add(call.id);
			}
			continue;
		}
		if (message.role === "tool") {
			toolOutputCallIds.add(message.tool_call_id);
		}
	}
	if (assistantCallIds.size === 0 && toolOutputCallIds.size === 0) {
		return messages;
	}

	const validCallIds = new Set<string>();
	for (const callId of assistantCallIds) {
		if (toolOutputCallIds.has(callId)) {
			validCallIds.add(callId);
		}
	}

	if (
		validCallIds.size === assistantCallIds.size &&
		validCallIds.size === toolOutputCallIds.size
	) {
		return messages;
	}

	let changed = false;
	const normalized: BaseMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			const calls = message.tool_calls ?? [];
			if (calls.length > 0) {
				const filteredCalls = calls.filter((call) => validCallIds.has(call.id));
				if (filteredCalls.length !== calls.length) {
					changed = true;
					if (filteredCalls.length === 0) {
						const next = { ...message };
						delete next.tool_calls;
						normalized.push(next);
					} else {
						normalized.push({ ...message, tool_calls: filteredCalls });
					}
					continue;
				}
			}
			normalized.push(message);
			continue;
		}
		if (message.role === "tool" && !validCallIds.has(message.tool_call_id)) {
			changed = true;
			continue;
		}
		normalized.push(message);
	}

	return changed ? normalized : messages;
};

export const isAbortLikeError = (error: Error): boolean =>
	error.name === "AbortError" ||
	error.name === "APIUserAbortError" ||
	error.name === "AbortSignal" ||
	/aborted|abort/i.test(error.message);
