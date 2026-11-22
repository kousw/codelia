import type {
	ClientToolCallRequestParams,
	ClientToolCallResult,
} from "@codelia/protocol";
import { log } from "../logger";
import type { RuntimeState } from "../runtime-state";
import { notificationMessage, parseUiResult, requestMessage } from "./protocol";
import { send } from "./transport";

export const requestClientToolCall = async (
	state: RuntimeState,
	params: ClientToolCallRequestParams,
	timeoutMs?: number,
): Promise<ClientToolCallResult> => {
	const id = state.nextUiRequestId();
	send(requestMessage("client.tool.call", id, params));
	const raw = await state.waitForUiResponse<unknown>(id, timeoutMs, () => {
		send(
			notificationMessage("client.tool.cancel", {
				request_id: id,
				run_id: params.run_id,
				name: params.name,
				reason: "timeout",
			}),
		);
	});
	const parsed = parseUiResult("client.tool.call", raw);
	if (parsed.ok) return parsed.result;
	// Issues name fields and expected kinds only, never the client's values.
	log(
		`protocol mismatch: client.tool.call result for ${params.name}: ${JSON.stringify(parsed.issues)}`,
	);
	return {
		ok: false,
		error: "The client returned a result that does not match the protocol.",
	};
};
