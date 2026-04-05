import type { UiResponsePayload } from "../../../shared/rpc";
import type { StreamUiRequest } from "../../../shared/types";
import {
	continueAfterModalResponse,
	dismissPendingLocalDialog,
	setComposer,
	setErrorMessage,
	setModalText,
	toggleModalPick,
} from "../../state/actions";
import { getDesktopViewState } from "../../state/desktop-store";
import { rpc } from "../runtime";

export const submitModal = async (result: UiResponsePayload): Promise<void> => {
	const currentState = getDesktopViewState();
	if (!currentState.pendingUiRequest) return;
	await rpc.request.respondUiRequest({
		request_id: currentState.pendingUiRequest.request_id,
		result,
	});
	continueAfterModalResponse();
};

export const resolveModalDismissPayload = (
	request: StreamUiRequest,
): UiResponsePayload => {
	if (request.method === "ui.confirm.request") {
		return { ok: false };
	}
	if (request.method === "ui.prompt.request") {
		return { value: null };
	}
	return { ids: [] };
};

export {
	dismissPendingLocalDialog,
	setComposer,
	setErrorMessage,
	setModalText,
	toggleModalPick,
};
