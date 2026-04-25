import type { DesktopSnapshot } from "../../../shared/types";
import { commitState } from "../desktop-store";
import { hydrateSnapshotWithLiveRuns } from "./shared";

export const applySessionLoaded = (
	snapshot: DesktopSnapshot,
	sessionId: string | null,
): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
		draft.pendingShellResults = [];
		draft.composerNotice = null;
		draft.statusLine = sessionId ? "Session loaded" : "Draft";
	});
};

export const applySessionRenamed = (snapshot: DesktopSnapshot): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
	});
};

export const showPendingHideSessionDialog = (
	sessionId: string,
	sessionTitle: string,
): void => {
	commitState((draft) => {
		draft.pendingLocalDialog = {
			kind: "hide-session",
			sessionId,
			sessionTitle,
		};
	});
};

export const applyHiddenSession = (snapshot: DesktopSnapshot): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
		draft.pendingLocalDialog = null;
		draft.statusLine = "Session hidden";
	});
};
