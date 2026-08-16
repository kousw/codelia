import type {
	ClientToolCancelParams,
	ClientToolCallRequestParams,
	ClientToolCallResult,
	RpcNotification,
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
	return await state.waitForUiResponse<ClientToolCallResult>(
		id,
		timeoutMs,
		() => {
			const notification: RpcNotification = {
				jsonrpc: "2.0",
				method: "client.tool.cancel",
				params: {
					request_id: id,
					run_id: params.run_id,
					name: params.name,
					reason: "timeout",
				} satisfies ClientToolCancelParams,
			};
			send(notification);
		},
	);
};
