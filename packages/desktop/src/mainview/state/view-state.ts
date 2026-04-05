import type {
	DesktopSnapshot,
	InspectBundle,
	StreamUiRequest,
} from "../../shared/types";

export type ViewState = {
	snapshot: DesktopSnapshot;
	inspect: InspectBundle | null;
	inspectOpen: boolean;
	composer: string;
	activeRunId: string | null;
	activeSteps: Array<{
		step_id: string;
		step_number: number;
		title: string;
	}>;
	isStreaming: boolean;
	statusLine: string;
	errorMessage: string | null;
	pendingUiRequest: StreamUiRequest | null;
	pendingLocalDialog: {
		kind: "hide-session";
		sessionId: string;
		sessionTitle: string;
	} | null;
	modalText: string;
	modalPickIds: string[];
};

export const emptySnapshot: DesktopSnapshot = {
	workspaces: [],
	sessions: [],
	transcript: [],
};

export const createInitialViewState = (): ViewState => ({
	snapshot: emptySnapshot,
	inspect: null,
	inspectOpen: false,
	composer: "",
	activeRunId: null,
	activeSteps: [],
	isStreaming: false,
	statusLine: "Idle",
	errorMessage: null,
	pendingUiRequest: null,
	pendingLocalDialog: null,
	modalText: "",
	modalPickIds: [],
});

export const hydrateSnapshotDraft = (
	draft: ViewState,
	snapshot: DesktopSnapshot,
): void => {
	draft.snapshot = snapshot;
	draft.activeSteps = [];
};
