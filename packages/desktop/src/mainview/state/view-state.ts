import type { ShellExecResult } from "../../../../protocol/src/index";
import { clampSidebarWidth, DEFAULT_SIDEBAR_WIDTH } from "../../shared/layout";
import type {
	DesktopSnapshot,
	InspectBundle,
	StreamEvent,
	StreamUiRequest,
} from "../../shared/types";

export type PendingShellResult = ShellExecResult & {
	id: string;
};

export type ActiveStep = {
	step_id: string;
	step_number: number;
	title: string;
};

export type LiveRunState = {
	runId: string;
	sessionId?: string;
	workspacePath?: string;
	status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled";
	events: StreamEvent[];
	activeSteps: ActiveStep[];
	contextLeftPercent: number | null;
};

export type ViewState = {
	snapshot: DesktopSnapshot;
	inspect: InspectBundle | null;
	inspectOpen: boolean;
	sidebarWidth: number;
	composer: string;
	composerNotice: string | null;
	pendingShellResults: PendingShellResult[];
	isShellRunning: boolean;
	activeRunId: string | null;
	activeSteps: ActiveStep[];
	liveRuns: Record<string, LiveRunState>;
	contextLeftPercent: number | null;
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

const createEmptySnapshot = (): DesktopSnapshot => ({
	workspaces: [],
	sessions: [],
	transcript: [],
});

export const createInitialViewState = (): ViewState => ({
	snapshot: createEmptySnapshot(),
	inspect: null,
	inspectOpen: false,
	sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
	composer: "",
	composerNotice: null,
	pendingShellResults: [],
	isShellRunning: false,
	activeRunId: null,
	activeSteps: [],
	liveRuns: {},
	contextLeftPercent: null,
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
	if (snapshot.ui_preferences?.sidebar_width !== undefined) {
		draft.sidebarWidth = clampSidebarWidth(
			snapshot.ui_preferences.sidebar_width,
		);
	}
	draft.activeSteps = [];
};
