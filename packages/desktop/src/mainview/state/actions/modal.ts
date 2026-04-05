import type { StreamEvent } from "../../../shared/types";
import { commitState } from "../desktop-store";

export const applyUiRequestEvent = (
	event: Extract<StreamEvent, { kind: "ui.request" }>,
): void => {
	commitState((draft) => {
		draft.pendingUiRequest = event;
		draft.modalText =
			event.method === "ui.prompt.request" &&
			"default_value" in event.params &&
			event.params.default_value
				? event.params.default_value
				: "";
		draft.modalPickIds = [];
		draft.statusLine = "Waiting for input";
	});
};

export const continueAfterModalResponse = (): void => {
	commitState((draft) => {
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
