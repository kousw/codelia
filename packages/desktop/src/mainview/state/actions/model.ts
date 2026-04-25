import type { DesktopSnapshot } from "../../../shared/types";
import { commitState } from "../desktop-store";
import { hydrateSnapshotWithLiveRuns } from "./shared";

export const applyControlSnapshot = (
	snapshot: DesktopSnapshot,
	statusLine: string,
): void => {
	commitState((draft) => {
		hydrateSnapshotWithLiveRuns(draft, snapshot);
		draft.statusLine = statusLine;
	});
};
