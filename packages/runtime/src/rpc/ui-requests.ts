import type {
	RpcRequest,
	UiClipboardReadRequestParams,
	UiClipboardReadResult,
	UiConfirmRequestParams,
	UiConfirmResult,
	UiPickRequestParams,
	UiPickResult,
	UiPromptRequestParams,
	UiPromptResult,
} from "@codelia/protocol";
import type { RuntimeState } from "../runtime-state";
import { send } from "./transport";

type UiRequestMap = {
	"ui.confirm.request": {
		params: UiConfirmRequestParams;
		result: UiConfirmResult;
	};
	"ui.prompt.request": {
		params: UiPromptRequestParams;
		result: UiPromptResult;
	};
	"ui.pick.request": {
		params: UiPickRequestParams;
		result: UiPickResult;
	};
	"ui.clipboard.read": {
		params: UiClipboardReadRequestParams;
		result: UiClipboardReadResult;
	};
};

const requestUi = async <TMethod extends keyof UiRequestMap>(
	state: RuntimeState,
	method: TMethod,
	params: UiRequestMap[TMethod]["params"],
): Promise<UiRequestMap[TMethod]["result"] | null> => {
	const id = state.nextUiRequestId();
	const request: RpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};
	send(request);
	try {
		return await state.waitForUiResponse<UiRequestMap[TMethod]["result"]>(id);
	} catch {
		return null;
	}
};

export const requestUiConfirm = async (
	state: RuntimeState,
	params: UiConfirmRequestParams,
): Promise<UiConfirmResult | null> => {
	return requestUi(state, "ui.confirm.request", params);
};

export const requestUiPrompt = async (
	state: RuntimeState,
	params: UiPromptRequestParams,
): Promise<UiPromptResult | null> => {
	return requestUi(state, "ui.prompt.request", params);
};

export const requestUiPick = async (
	state: RuntimeState,
	params: UiPickRequestParams,
): Promise<UiPickResult | null> => {
	return requestUi(state, "ui.pick.request", params);
};

export const requestUiClipboardRead = async (
	state: RuntimeState,
	params: UiClipboardReadRequestParams,
): Promise<UiClipboardReadResult | null> => {
	if (!state.uiCapabilities?.supports_clipboard_read) {
		return null;
	}
	return requestUi(state, "ui.clipboard.read", params);
};
