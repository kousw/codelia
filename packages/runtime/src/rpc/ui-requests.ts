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
	let sent = false;
	const abort = () => {
		const cancelled = state.resolveUiResponse({
			jsonrpc: "2.0",
			id,
			error: {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "UI request cancelled",
			},
		});
		if (cancelled && sent && method === "ui.pick.request") {
			send({ jsonrpc: "2.0", method: "ui.pick.cancelled", params: { id } });
		}
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		else {
			send(request);
			sent = true;
		}
		return await response;
	} catch {
		return null;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
};

// The TUI shares picker and approval state across setup, root tools and children.
const modalRequests = new WeakMap<RuntimeState, Promise<unknown>>();

const requestModal = <TMethod extends "ui.confirm.request" | "ui.pick.request">(
	state: RuntimeState,
	method: TMethod,
	params: UiRequestMap[TMethod]["params"],
	signal?: AbortSignal,
): Promise<UiRequestMap[TMethod]["result"] | null> => {
	if (signal?.aborted) return Promise.resolve(null);
	const previous = modalRequests.get(state);
	const request = () => requestUi(state, method, params, signal);
	const pending = previous ? previous.then(request) : request();
	modalRequests.set(state, pending);
	const clear = () => {
		if (modalRequests.get(state) === pending) modalRequests.delete(state);
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

export const requestUiConfirm = (
	state: RuntimeState,
	params: UiConfirmRequestParams,
	signal?: AbortSignal,
): Promise<UiConfirmResult | null> =>
	requestModal(state, "ui.confirm.request", params, signal);

export const requestUiPrompt = async (
	state: RuntimeState,
	params: UiPromptRequestParams,
	signal?: AbortSignal,
): Promise<UiPromptResult | null> => {
	return requestUi(state, "ui.prompt.request", params, signal);
};

export const requestUiPick = (
	state: RuntimeState,
	params: UiPickRequestParams,
	signal?: AbortSignal,
): Promise<UiPickResult | null> =>
	requestModal(state, "ui.pick.request", params, signal);
