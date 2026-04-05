import type { StreamEvent } from "../../../shared/types";
import type { ViewState } from "../view-state";

export const createMessageId = (() => {
	let next = 0;
	return () => `view-msg-${++next}-${Date.now()}`;
})();

export const formatDurationMs = (value: number): string => {
	if (value >= 10_000) {
		return `${Math.round(value / 1000)}s`;
	}
	if (value >= 1_000) {
		return `${(value / 1000).toFixed(1)}s`;
	}
	return `${value}ms`;
};

export const describeActiveSteps = (state: ViewState): string => {
	if (state.activeSteps.length === 0) {
		return state.isStreaming ? "Running" : "Idle";
	}
	const latest = state.activeSteps[state.activeSteps.length - 1];
	const current = `Step ${latest.step_number}: ${latest.title}`;
	return state.activeSteps.length === 1
		? current
		: `${current} (+${state.activeSteps.length - 1} more)`;
};

export const appendAssistantEvent = (
	messages: ViewState["snapshot"]["transcript"],
	event: StreamEvent,
): ViewState["snapshot"]["transcript"] => {
	if (
		event.kind !== "agent.event" ||
		event.event.type === "hidden_user_message"
	) {
		return messages;
	}
	const next = [...messages];
	let assistant = next[next.length - 1];
	if (!assistant || assistant.role !== "assistant") {
		assistant = {
			id: createMessageId(),
			role: "assistant",
			content: "",
			events: [],
			timestamp: Date.now(),
		};
		next.push(assistant);
	}
	const updated = {
		...assistant,
		events: [...assistant.events, event.event],
	};
	if (event.event.type === "text") {
		updated.content += event.event.content;
	}
	if (event.event.type === "final") {
		updated.content = event.event.content;
	}
	next[next.length - 1] = updated;
	return next;
};
