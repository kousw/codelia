import { commitState } from "../desktop-store";
import type { PendingShellResult } from "../view-state";
import { createMessageId } from "./shared";

export const appendErrorMessage = (message: string): void => {
	commitState((draft) => {
		draft.errorMessage = message;
	});
};

export const beginPromptRun = (message: string): void => {
	commitState((draft) => {
		draft.errorMessage = null;
		draft.composerNotice = null;
		draft.composer = "";
		draft.isStreaming = true;
		draft.activeSteps = [];
		draft.statusLine = "Starting";
		draft.snapshot.transcript = [
			...draft.snapshot.transcript,
			{
				id: createMessageId(),
				role: "user",
				content: message,
				events: [],
				timestamp: Date.now(),
			},
			{
				id: createMessageId(),
				role: "assistant",
				content: "",
				events: [],
				timestamp: Date.now() + 1,
			},
		];
	});
};

export const beginShellCommand = (command: string): void => {
	commitState((draft) => {
		draft.errorMessage = null;
		draft.composerNotice = null;
		draft.composer = "";
		draft.isShellRunning = true;
		draft.statusLine = `Shell: ${command}`;
	});
};

export const finishShellCommand = (result: PendingShellResult): void => {
	const exitLabel =
		result.exit_code === null ? (result.signal ?? "signal") : result.exit_code;
	commitState((draft) => {
		draft.isShellRunning = false;
		draft.pendingShellResults = [...draft.pendingShellResults, result];
		draft.composerNotice = `Shell result queued (${draft.pendingShellResults.length}) · exit ${exitLabel}`;
		draft.statusLine = "Shell result queued";
	});
};

export const failShellCommand = (error: unknown): void => {
	commitState((draft) => {
		draft.isShellRunning = false;
		draft.errorMessage = String(error);
		draft.statusLine = "Shell failed";
	});
};

export const clearPendingShellResults = (): void => {
	commitState((draft) => {
		draft.pendingShellResults = [];
		draft.composerNotice = null;
	});
};

export const setComposerNotice = (message: string | null): void => {
	commitState((draft) => {
		draft.composerNotice = message;
		draft.errorMessage = null;
	});
};

export const appendLocalExchange = (
	userMessage: string,
	assistantMessage: string,
): void => {
	commitState((draft) => {
		draft.errorMessage = null;
		draft.composer = "";
		draft.composerNotice = null;
		draft.snapshot.transcript = [
			...draft.snapshot.transcript,
			{
				id: createMessageId(),
				role: "user",
				content: userMessage,
				events: [],
				timestamp: Date.now(),
			},
			{
				id: createMessageId(),
				role: "assistant",
				content: assistantMessage,
				events: [],
				timestamp: Date.now() + 1,
			},
		];
	});
};

export const attachStartedRun = (started: {
	run_id: string;
	session_id?: string | null;
	workspace_path?: string;
}): void => {
	commitState((draft) => {
		draft.activeRunId = started.run_id;
		if (started.session_id) {
			draft.snapshot.selected_session_id = started.session_id;
		}
		draft.liveRuns = {
			...draft.liveRuns,
			[started.run_id]: {
				runId: started.run_id,
				sessionId: started.session_id ?? undefined,
				workspacePath: started.workspace_path,
				status: "running",
				events: [],
				activeSteps: [],
				contextLeftPercent: null,
			},
		};
	});
};

export const revertPromptRunStart = (error: unknown): void => {
	commitState((draft) => {
		draft.isStreaming = false;
		draft.activeSteps = [];
		draft.errorMessage = String(error);
		draft.statusLine = "Error";
		if (
			draft.snapshot.transcript.at(-1)?.role === "assistant" &&
			draft.snapshot.transcript.at(-1)?.content === "" &&
			draft.snapshot.transcript.at(-1)?.events.length === 0
		) {
			draft.snapshot.transcript = draft.snapshot.transcript.slice(0, -1);
		}
	});
};

export const setComposer = (value: string): void => {
	commitState((draft) => {
		draft.composer = value;
		if (value.trim()) {
			draft.composerNotice = null;
		}
	});
};

export const setErrorMessage = (message: string | null): void => {
	commitState((draft) => {
		draft.errorMessage = message;
	});
};
