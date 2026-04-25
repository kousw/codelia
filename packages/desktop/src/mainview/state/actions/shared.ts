import type { DesktopSnapshot, StreamEvent } from "../../../shared/types";
import type { LiveRunState, ViewState } from "../view-state";
import { hydrateSnapshotDraft } from "../view-state";

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

export const describeLiveRunSteps = (run: LiveRunState): string => {
	if (run.activeSteps.length === 0) {
		return run.status === "running" || run.status === "awaiting_ui"
			? "Running"
			: "Idle";
	}
	const latest = run.activeSteps[run.activeSteps.length - 1];
	const current = `Step ${latest.step_number}: ${latest.title}`;
	return run.activeSteps.length === 1
		? current
		: `${current} (+${run.activeSteps.length - 1} more)`;
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

export const isTerminalRunStatus = (status: LiveRunState["status"]): boolean =>
	status === "completed" || status === "cancelled" || status === "error";

export const getEventRunId = (event: StreamEvent): string | undefined =>
	"run_id" in event ? event.run_id : undefined;

export const getEventSessionId = (event: StreamEvent): string | undefined =>
	"session_id" in event ? event.session_id : undefined;

export const getEventWorkspacePath = (
	event: StreamEvent,
): string | undefined =>
	"workspace_path" in event ? event.workspace_path : undefined;

export const runMatchesVisibleSession = (
	state: ViewState,
	run: LiveRunState,
): boolean => {
	const selectedSessionId = state.snapshot.selected_session_id;
	if (selectedSessionId) {
		return run.sessionId === selectedSessionId;
	}
	return state.activeRunId === run.runId;
};

export const hydrateSnapshotWithLiveRuns = (
	draft: ViewState,
	snapshot: DesktopSnapshot,
): void => {
	hydrateSnapshotDraft(draft, snapshot);
	draft.activeRunId = null;
	draft.activeSteps = [];
	draft.contextLeftPercent = null;
	draft.isStreaming = false;

	const selectedSessionId = draft.snapshot.selected_session_id;
	if (!selectedSessionId) {
		return;
	}

	let transcript = draft.snapshot.transcript;
	for (const run of Object.values(draft.liveRuns)) {
		if (
			run.sessionId !== selectedSessionId ||
			isTerminalRunStatus(run.status)
		) {
			continue;
		}
		for (const event of run.events) {
			transcript = appendAssistantEvent(transcript, event);
		}
		draft.activeRunId = run.runId;
		draft.activeSteps = [...run.activeSteps];
		draft.contextLeftPercent = run.contextLeftPercent;
		draft.isStreaming = true;
	}
	draft.snapshot.transcript = transcript;
};
