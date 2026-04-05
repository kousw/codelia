import type { DesktopSnapshot } from "../../../shared/types";
import { commitState } from "../desktop-store";
import { hydrateSnapshotDraft } from "../view-state";

export const applyModelSnapshot = (
	snapshot: DesktopSnapshot,
	statusLine: string,
): void => {
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
		draft.statusLine = statusLine;
	});
};
