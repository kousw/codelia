import type {
	ClientToolCallRequestParams,
	ClientToolCallResult,
	RpcRequest,
} from "@codelia/protocol";
import type { RuntimeState } from "../runtime-state";
import { send } from "./transport";

export const requestClientToolCall = async (
	state: RuntimeState,
	params: ClientToolCallRequestParams,
	timeoutMs?: number,
): Promise<ClientToolCallResult> => {
	const id = state.nextUiRequestId();
	const request: RpcRequest = {
		jsonrpc: "2.0",
		id,
		method: "client.tool.call",
		params,
	};
	send(request);
	return await state.waitForUiResponse<ClientToolCallResult>(id, timeoutMs);
};
