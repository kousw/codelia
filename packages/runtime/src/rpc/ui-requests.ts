import {
	RPC_ERROR_CODE,
	type RpcRequest,
	type UiConfirmRequestParams,
	type UiConfirmResult,
	type UiPickRequestParams,
	type UiPickResult,
	type UiPromptRequestParams,
	type UiPromptResult,
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
};

const requestUi = async <TMethod extends keyof UiRequestMap>(
	state: RuntimeState,
	method: TMethod,
	params: UiRequestMap[TMethod]["params"],
	signal?: AbortSignal,
): Promise<UiRequestMap[TMethod]["result"] | null> => {
	if (signal?.aborted) return null;
	const id = state.nextUiRequestId();
	const request: RpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};
	const response = state.waitForUiResponse<UiRequestMap[TMethod]["result"]>(id);
	const abort = () =>
		state.resolveUiResponse({
			jsonrpc: "2.0",
			id,
			error: {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "UI request cancelled",
			},
		});
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		else send(request);
		return await response;
	} catch {
		return null;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
};

// The TUI has one confirmation slot, shared by root tools and all children.
const confirmations = new WeakMap<RuntimeState, Promise<unknown>>();

export const requestUiConfirm = async (
	state: RuntimeState,
	params: UiConfirmRequestParams,
	signal?: AbortSignal,
): Promise<UiConfirmResult | null> => {
	if (signal?.aborted) return null;
	const previous = confirmations.get(state);
	const request = () => requestUi(state, "ui.confirm.request", params, signal);
	const pending = previous ? previous.then(request) : request();
	confirmations.set(state, pending);
	const clear = () => {
		if (confirmations.get(state) === pending) confirmations.delete(state);
	};
	void pending.then(clear, clear);
	// A queued cancellation settles immediately, but must not release the active
	// request's slot. requestUi skips this entry when its turn eventually arrives.
	if (!signal) return pending;
	return new Promise((resolve) => {
		const abort = () => resolve(null);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		void pending.then((result) => {
			signal.removeEventListener("abort", abort);
			resolve(result);
		});
	});
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
