import type { StreamEvent } from "../../../shared/types";
import { commitState } from "../desktop-store";
import type { LiveRunState, ViewState } from "../view-state";
import {
	getEventRunId,
	getEventSessionId,
	getEventWorkspacePath,
	runMatchesVisibleSession,
} from "./shared";

const upsertAwaitingUiRun = (
	draft: ViewState,
	event: Extract<StreamEvent, { kind: "ui.request" }>,
): LiveRunState | null => {
	const runId = getEventRunId(event);
	if (!runId) {
		return null;
	}
	const existing = draft.liveRuns[runId];
	const run: LiveRunState = {
		runId,
		sessionId: getEventSessionId(event) ?? existing?.sessionId,
		workspacePath: getEventWorkspacePath(event) ?? existing?.workspacePath,
		status: "awaiting_ui",
		events: existing ? [...existing.events, event] : [event],
		activeSteps: existing?.activeSteps ?? [],
		contextLeftPercent: existing?.contextLeftPercent ?? null,
	};
	draft.liveRuns = {
		...draft.liveRuns,
		[runId]: run,
	};
	return run;
};

export const applyUiRequestEvent = (
	event: Extract<StreamEvent, { kind: "ui.request" }>,
): void => {
	commitState((draft) => {
		const run = upsertAwaitingUiRun(draft, event);
		draft.pendingUiRequest = event;
		draft.modalText =
			event.method === "ui.prompt.request" &&
			"default_value" in event.params &&
			event.params.default_value
				? event.params.default_value
				: "";
		draft.modalPickIds = [];
		if (!run || runMatchesVisibleSession(draft, run)) {
			draft.statusLine = "Waiting for input";
		}
	});
};

export const continueAfterModalResponse = (): void => {
	commitState((draft) => {
		const runId = draft.pendingUiRequest?.run_id;
		const run = runId ? draft.liveRuns[runId] : undefined;
		if (runId && run) {
			draft.liveRuns = {
				...draft.liveRuns,
				[runId]: {
					...run,
					status: "running",
				},
			};
		}
		draft.pendingUiRequest = null;
		draft.modalText = "";
		draft.modalPickIds = [];
		draft.statusLine = "Continuing";
	});
};

export const setModalText = (value: string): void => {
	commitState((draft) => {
		draft.modalText = value;
	});
};

export const toggleModalPick = (
	itemId: string,
	multi: boolean,
	checked: boolean,
): void => {
	commitState((draft) => {
		if (multi) {
			if (checked) {
				draft.modalPickIds = [...new Set([...draft.modalPickIds, itemId])];
			} else {
				draft.modalPickIds = draft.modalPickIds.filter(
					(value) => value !== itemId,
				);
			}
			return;
		}
		draft.modalPickIds = checked ? [itemId] : [];
	});
};

export const dismissPendingLocalDialog = (): void => {
	commitState((draft) => {
		draft.pendingLocalDialog = null;
	});
};
