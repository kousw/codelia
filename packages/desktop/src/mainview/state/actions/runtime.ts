import type { DesktopSnapshot, StreamEvent } from "../../../shared/types";
import { commitState } from "../desktop-store";
import { hydrateSnapshotDraft } from "../view-state";
import {
	appendAssistantEvent,
	describeActiveSteps,
	formatDurationMs,
} from "./shared";

export const applyHydratedSnapshot = (snapshot: DesktopSnapshot): void => {
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
	});
};

export const applyMenuAction = (payload: {
	snapshot?: DesktopSnapshot;
	action: string;
}): void => {
	commitState((draft) => {
		if (payload.snapshot) {
			hydrateSnapshotDraft(draft, payload.snapshot);
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
		const agentEvent = event.event;
		if (agentEvent.type === "step_start") {
			draft.activeSteps = [
				...draft.activeSteps.filter(
					(step) => step.step_id !== agentEvent.step_id,
				),
				{
					step_id: agentEvent.step_id,
					step_number: agentEvent.step_number,
					title: agentEvent.title,
				},
			];
			draft.statusLine = describeActiveSteps(draft);
		} else if (agentEvent.type === "step_complete") {
			const completed = draft.activeSteps.find(
				(step) => step.step_id === agentEvent.step_id,
			);
			draft.activeSteps = draft.activeSteps.filter(
				(step) => step.step_id !== agentEvent.step_id,
			);
			draft.statusLine =
				agentEvent.status === "error"
					? `${completed ? `Step ${completed.step_number}: ${completed.title}` : "Step"} failed in ${formatDurationMs(
							agentEvent.duration_ms,
						)}`
					: describeActiveSteps(draft);
		} else if (agentEvent.type === "compaction_start") {
			draft.statusLine = "Compaction running";
		} else if (agentEvent.type === "compaction_complete") {
			draft.statusLine = agentEvent.compacted
				? "Compaction completed"
				: "Compaction skipped";
		}
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
		draft.statusLine =
			event.status === "error" && event.message
				? `Error: ${event.message}`
				: event.status === "running" && draft.activeSteps.length > 0
					? describeActiveSteps(draft)
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
		draft.statusLine =
			draft.activeSteps.length > 0
				? `${describeActiveSteps(draft)} · context ${event.context_left_percent}% left`
				: `Context ${event.context_left_percent}% left`;
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
