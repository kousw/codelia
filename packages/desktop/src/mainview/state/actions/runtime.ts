import type { DesktopSnapshot, StreamEvent } from "../../../shared/types";
import { commitState } from "../desktop-store";
import type { LiveRunState, ViewState } from "../view-state";
import {
	appendAssistantEvent,
	describeLiveRunSteps,
	formatDurationMs,
	getEventRunId,
	getEventSessionId,
	getEventWorkspacePath,
	hydrateSnapshotWithLiveRuns,
	isTerminalRunStatus,
	runMatchesVisibleSession,
} from "./shared";

const upsertLiveRun = (
	draft: ViewState,
	event: StreamEvent,
): LiveRunState | null => {
	const runId = getEventRunId(event);
	if (!runId) {
		return null;
	}
	const existing = draft.liveRuns[runId];
	const next: LiveRunState = {
		runId,
		sessionId: getEventSessionId(event) ?? existing?.sessionId,
		workspacePath: getEventWorkspacePath(event) ?? existing?.workspacePath,
		status: existing?.status ?? "running",
		events: existing ? [...existing.events, event] : [event],
		activeSteps: existing?.activeSteps ?? [],
		contextLeftPercent: existing?.contextLeftPercent ?? null,
	};
	draft.liveRuns = {
		...draft.liveRuns,
		[runId]: next,
	};
	return next;
};

const replaceLiveRun = (draft: ViewState, run: LiveRunState): void => {
	draft.liveRuns = {
		...draft.liveRuns,
		[run.runId]: run,
	};
};

const removeLiveRun = (draft: ViewState, runId: string): void => {
	const { [runId]: _removed, ...remaining } = draft.liveRuns;
	draft.liveRuns = remaining;
};

const syncVisibleRunChrome = (draft: ViewState, run: LiveRunState): void => {
	if (!runMatchesVisibleSession(draft, run)) {
		return;
	}
	draft.activeRunId = isTerminalRunStatus(run.status) ? null : run.runId;
	draft.activeSteps = [...run.activeSteps];
	draft.contextLeftPercent = run.contextLeftPercent;
	draft.isStreaming = !isTerminalRunStatus(run.status);
};

export const applyHydratedSnapshot = (snapshot: DesktopSnapshot): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
	});
};

export const applyMenuAction = (payload: {
	snapshot?: DesktopSnapshot;
	action: string;
}): void => {
	commitState((draft) => {
		if (payload.snapshot) {
			hydrateSnapshotWithLiveRuns(draft, payload.snapshot);
		}
		if (payload.action === "new-chat") {
			draft.snapshot.selected_session_id = undefined;
			draft.snapshot.transcript = [];
			draft.activeRunId = null;
			draft.activeSteps = [];
			draft.isStreaming = false;
			draft.inspectOpen = false;
			draft.statusLine = "Draft";
		}
	});
};

export const applyToastMessage = (message: string): void => {
	commitState((draft) => {
		draft.errorMessage = message;
	});
};

export const applyAgentRunEvent = (
	event: Extract<StreamEvent, { kind: "agent.event" }>,
): void => {
	commitState((draft) => {
		const run = upsertLiveRun(draft, event);
		if (!run) {
			return;
		}
		const agentEvent = event.event;
		let failedStepLabel: string | null = null;
		if (agentEvent.type === "step_start") {
			run.activeSteps = [
				...run.activeSteps.filter(
					(step) => step.step_id !== agentEvent.step_id,
				),
				{
					step_id: agentEvent.step_id,
					step_number: agentEvent.step_number,
					title: agentEvent.title,
				},
			];
		} else if (agentEvent.type === "step_complete") {
			const completed = run.activeSteps.find(
				(step) => step.step_id === agentEvent.step_id,
			);
			if (agentEvent.status === "error") {
				failedStepLabel = completed
					? `Step ${completed.step_number}: ${completed.title}`
					: "Step";
			}
			run.activeSteps = run.activeSteps.filter(
				(step) => step.step_id !== agentEvent.step_id,
			);
		} else if (agentEvent.type === "compaction_start") {
			// Status is synced below only when this run is visible.
		} else if (agentEvent.type === "compaction_complete") {
			// Status is synced below only when this run is visible.
		}
		replaceLiveRun(draft, run);
		if (!runMatchesVisibleSession(draft, run)) {
			return;
		}
		if (agentEvent.type === "step_complete" && agentEvent.status === "error") {
			draft.statusLine = `${failedStepLabel ?? "Step"} failed in ${formatDurationMs(
				agentEvent.duration_ms,
			)}`;
		} else if (agentEvent.type === "compaction_start") {
			draft.statusLine = "Compaction running";
		} else if (agentEvent.type === "compaction_complete") {
			draft.statusLine = agentEvent.compacted
				? "Compaction completed"
				: "Compaction skipped";
		} else {
			draft.statusLine = describeLiveRunSteps(run);
		}
		syncVisibleRunChrome(draft, run);
		draft.snapshot.transcript = appendAssistantEvent(
			draft.snapshot.transcript,
			event,
		);
	});
};

export const applyRunStatusEvent = (
	event: Extract<StreamEvent, { kind: "run.status" }>,
): void => {
	commitState((draft) => {
		const run = upsertLiveRun(draft, event);
		if (!run) {
			return;
		}
		run.status = event.status;
		replaceLiveRun(draft, run);
		if (!runMatchesVisibleSession(draft, run)) {
			return;
		}
		draft.statusLine =
			event.status === "error" && event.message
				? `Error: ${event.message}`
				: event.status === "running" && run.activeSteps.length > 0
					? describeLiveRunSteps(run)
					: event.status;
		if (event.status === "error") {
			draft.isStreaming = false;
			draft.activeRunId = null;
			draft.activeSteps = [];
			draft.errorMessage = event.message ?? "Run failed";
			return;
		}
		if (event.status !== "running") {
			draft.errorMessage = null;
		}
		if (event.status === "completed" || event.status === "cancelled") {
			draft.isStreaming = false;
			draft.activeRunId = null;
			draft.activeSteps = [];
		}
	});
};

export const applyRunContextEvent = (
	event: Extract<StreamEvent, { kind: "run.context" }>,
): void => {
	commitState((draft) => {
		const run = upsertLiveRun(draft, event);
		if (!run) {
			return;
		}
		run.contextLeftPercent = event.context_left_percent;
		replaceLiveRun(draft, run);
		if (!runMatchesVisibleSession(draft, run)) {
			return;
		}
		draft.contextLeftPercent = run.contextLeftPercent;
		draft.statusLine =
			run.activeSteps.length > 0
				? `${describeLiveRunSteps(run)} · context ${event.context_left_percent}% left`
				: `Context ${event.context_left_percent}% left`;
	});
};

export const finishStreamingRun = (
	event: Extract<StreamEvent, { kind: "done" }>,
): void => {
	commitState((draft) => {
		const run = upsertLiveRun(draft, event);
		if (!run) {
			return;
		}
		run.status = event.status;
		const wasVisible = runMatchesVisibleSession(draft, run);
		removeLiveRun(draft, run.runId);
		if (!wasVisible) {
			return;
		}
		draft.isStreaming = false;
		draft.activeRunId = null;
		draft.activeSteps = [];
		draft.contextLeftPercent = null;
	});
};

export const applyInitializeSnapshot = (snapshot: DesktopSnapshot): void => {
	applyHydratedSnapshot(snapshot);
};

export const applyInitializeError = (error: unknown): void => {
	commitState((draft) => {
		draft.errorMessage = String(error);
		draft.statusLine = "Error";
	});
};
