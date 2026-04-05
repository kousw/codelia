import { commitState } from "../desktop-store";
import { createMessageId } from "./shared";

export const appendErrorMessage = (message: string): void => {
	commitState((draft) => {
		draft.errorMessage = message;
	});
};

export const beginPromptRun = (message: string): void => {
	commitState((draft) => {
		draft.errorMessage = null;
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

export const attachStartedRun = (started: {
	run_id: string;
	session_id?: string | null;
}): void => {
	commitState((draft) => {
		draft.activeRunId = started.run_id;
		if (started.session_id) {
			draft.snapshot.selected_session_id = started.session_id;
		}
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

export const finishStreamingRun = (): void => {
	commitState((draft) => {
		draft.isStreaming = false;
		draft.activeRunId = null;
		draft.activeSteps = [];
	});
};

export const setComposer = (value: string): void => {
	commitState((draft) => {
		draft.composer = value;
	});
};

export const setErrorMessage = (message: string | null): void => {
	commitState((draft) => {
		draft.errorMessage = message;
	});
};
