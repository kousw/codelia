import {
	type ParamsOf,
	type ResultOf,
	RPC_ERROR_CODE,
	type UiConfirmRequestParams,
	type UiConfirmResult,
	type UiPickRequestParams,
	type UiPickResult,
	type UiPromptRequestParams,
	type UiPromptResult,
} from "@codelia/protocol";
import { log } from "../logger";
import type { RuntimeState } from "../runtime-state";
import { notificationMessage, parseUiResult, requestMessage } from "./protocol";
import { send } from "./transport";

type UiDialogMethod =
	| "ui.confirm.request"
	| "ui.prompt.request"
	| "ui.pick.request";

type UiModalMethod = Exclude<UiDialogMethod, "ui.prompt.request">;

/**
 * Sends a dialog request and waits for the UI. A cancelled request, an error
 * reply or a reply that does not match the protocol resolves to `null`, which
 * callers treat as a declined dialog.
 */
const requestUi = async <TMethod extends UiDialogMethod>(
	state: RuntimeState,
	method: TMethod,
	params: ParamsOf<TMethod>,
	signal?: AbortSignal,
): Promise<ResultOf<TMethod> | null> => {
	if (signal?.aborted) return null;
	const id = state.nextUiRequestId();
	const request = requestMessage(method, id, params);
	const response = state.waitForUiResponse<unknown>(id);
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
		if (!cancelled || !sent || method !== "ui.pick.request") return;
		send(notificationMessage("ui.pick.cancelled", { id }));
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		if (signal?.aborted) abort();
		else {
			send(request);
			sent = true;
		}
		const parsed = parseUiResult(method, await response);
		if (parsed.ok) return parsed.result;
		log(
			`protocol mismatch: ${method} result: ${JSON.stringify(parsed.issues)}`,
		);
		return null;
	} catch {
		return null;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
};

// The TUI shares picker and approval state across setup, root tools and children.
const modalRequests = new WeakMap<RuntimeState, Promise<unknown>>();

const requestModal = <TMethod extends UiModalMethod>(
	state: RuntimeState,
	method: TMethod,
	params: ParamsOf<TMethod>,
	signal?: AbortSignal,
): Promise<ResultOf<TMethod> | null> => {
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
