import type { DesktopSnapshot } from "../../../shared/types";
import { commitState } from "../desktop-store";
import { hydrateSnapshotWithLiveRuns } from "./shared";

const resetWorkspaceChrome = (
	snapshot: DesktopSnapshot,
	statusLine: string,
): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
		draft.inspect = null;
		draft.inspectOpen = false;
		draft.errorMessage = null;
		draft.statusLine = statusLine;
	});
};

export const applyWorkspaceOpened = (
	snapshot: DesktopSnapshot,
	statusLine: string,
): void => {
	resetWorkspaceChrome(snapshot, statusLine);
};

export const applyWorkspaceOpenError = (error: unknown): void => {
	commitState((draft) => {
		draft.errorMessage = String(error);
	});
};

export const applyWorkspaceReady = (snapshot: DesktopSnapshot): void => {
	resetWorkspaceChrome(snapshot, "Workspace ready");
};

export const setSidebarWidth = (width: number): void => {
	commitState((draft) => {
		draft.sidebarWidth = width;
	});
};
