import type { Agent, BaseMessage } from "@codelia/core";
import { stringifyContent } from "@codelia/core";
import { isDebugEnabled } from "../logger";

const DEBUG_MAX_CONTENT_CHARS = 2_000;
const DEBUG_MAX_LOG_CHARS = 20_000;
const DEBUG_MAX_EVENT_RESULT_CHARS = 500;
const DEBUG_MAX_EVENT_ARGS_CHARS = 2_000;
const DEBUG_ERROR_MESSAGE_MAX_CHARS = 2_000;
const DEBUG_ERROR_STACK_MAX_CHARS = 8_000;
const DEBUG_ERROR_CHAIN_MAX_CHARS = 4_000;
const DEBUG_ERROR_EXTRAS_MAX_CHARS = 4_000;
const DEBUG_PROVIDER_META_STRING_MAX_CHARS = 80;

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
			const rawArgs =
				typeof event.raw_args === "string"
					? event.raw_args
					: stringifyUnknown(event.args);
			const rawArgsSnippet = truncateText(rawArgs, DEBUG_MAX_EVENT_ARGS_CHARS);
			return `type=tool_call tool=${tool} tool_call_id=${toolCallId} raw_args=${stringifyUnknown(rawArgsSnippet)}`;
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

export const normalizeToolCallHistory = (
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

export const formatErrorForDebugLog = (error: Error): string => {
	const parts: string[] = [];
	parts.push(`name=${error.name}`);
	parts.push(
		`message=${truncateText(error.message, DEBUG_ERROR_MESSAGE_MAX_CHARS)}`,
	);
	if (error.stack) {
		parts.push(`stack=${truncateText(error.stack, DEBUG_ERROR_STACK_MAX_CHARS)}`);
	}
	const causeChain: string[] = [];
	let depth = 0;
	let current: unknown = (error as Error & { cause?: unknown }).cause;
	const seen = new Set<unknown>();
	while (current !== undefined && current !== null && depth < 4) {
		if (seen.has(current)) {
			causeChain.push("[circular]");
			break;
		}
		seen.add(current);
		if (current instanceof Error) {
			causeChain.push(`${current.name}: ${current.message}`);
			current = (current as Error & { cause?: unknown }).cause;
			depth += 1;
			continue;
		}
		causeChain.push(stringifyUnknown(current));
		break;
	}
	if (causeChain.length > 0) {
		parts.push(
			`cause_chain=${truncateText(causeChain.join(" <- "), DEBUG_ERROR_CHAIN_MAX_CHARS)}`,
		);
	}
	const extras = Object.entries(
		error as Error & Record<string, unknown>,
	).filter(([key]) => key !== "name" && key !== "message" && key !== "stack");
	if (extras.length > 0) {
		parts.push(
			`extras=${truncateText(
				stringifyUnknown(Object.fromEntries(extras)),
				DEBUG_ERROR_EXTRAS_MAX_CHARS,
			)}`,
		);
	}
	return parts.join(" ");
};

export const summarizeProviderMeta = (value: unknown): string | null => {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value.length > DEBUG_PROVIDER_META_STRING_MAX_CHARS
			? `${value.slice(0, DEBUG_PROVIDER_META_STRING_MAX_CHARS - 3)}...`
			: value;
	}
	if (Array.isArray(value)) {
		return `array(len=${value.length})`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const details: string[] = [];
		if (typeof obj.transport === "string") {
			details.push(`transport=${obj.transport}`);
		}
		if (typeof obj.websocket_mode === "string") {
			details.push(`websocket_mode=${obj.websocket_mode}`);
		}
		if (typeof obj.response_id === "string") {
			details.push(`response_id=${obj.response_id}`);
		}
		if (typeof obj.chain_reset === "boolean") {
			details.push(`chain_reset=${obj.chain_reset ? "true" : "false"}`);
		}
		if (typeof obj.fallback_used === "boolean") {
			details.push(`fallback_used=${obj.fallback_used ? "true" : "false"}`);
		}
		if (typeof obj.ws_input_mode === "string") {
			details.push(`ws_input_mode=${obj.ws_input_mode}`);
		}
		if (details.length > 0) {
			return details.join(" ");
		}
		const keys = Object.keys(obj);
		if (keys.length === 0) return "object";
		const shown = keys.slice(0, 4).join(",");
		return keys.length > 4
			? `object(keys=${shown},...)`
			: `object(keys=${shown})`;
	}
	return typeof value;
};

export const isAbortLikeError = (error: Error): boolean =>
	error.name === "AbortError" ||
	error.name === "APIUserAbortError" ||
	error.name === "AbortSignal" ||
	/aborted|abort/i.test(error.message);
