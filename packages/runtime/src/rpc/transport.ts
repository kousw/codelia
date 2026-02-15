import type {
	AgentEventNotify,
	RpcError,
	RpcMessage,
	RpcNotification,
	RpcResponse,
	RunContextNotify,
} from "@codelia/protocol";
import { debugLog } from "../logger";
import type { RuntimeState } from "../runtime-state";

const describeRpcMessage = (msg: RpcMessage): string => {
	if ("method" in msg && typeof msg.method === "string") {
		return msg.method;
	}
	if ("id" in msg && "result" in msg) {
		return `result:${msg.id}`;
	}
	if ("id" in msg && "error" in msg) {
		return `error:${msg.id}`;
	}
	return "unknown";
};

const serializeMessage = (
	msg: RpcMessage,
): { payload: string; label: string } => ({
	payload: `${JSON.stringify(msg)}\n`,
	label: describeRpcMessage(msg),
});

export const send = (msg: RpcMessage): void => {
	const { payload, label } = serializeMessage(msg);
	const writable = process.stdout.write(payload, (error) => {
		if (error) {
			debugLog(`transport.write.error label=${label} message=${error.message}`);
		}
	});
	if (!writable) {
		debugLog(`transport.backpressure label=${label} bytes=${payload.length}`);
	}
};

export const sendAsync = async (msg: RpcMessage): Promise<void> =>
	new Promise((resolve) => {
		const { payload, label } = serializeMessage(msg);
		const writable = process.stdout.write(payload, (error) => {
			if (error) {
				debugLog(
					`transport.write.error label=${label} message=${error.message}`,
				);
			}
			resolve();
		});
		if (!writable) {
			debugLog(`transport.backpressure label=${label} bytes=${payload.length}`);
		}
	});

export const sendError = (id: string, error: RpcError): void => {
	const response: RpcResponse = { jsonrpc: "2.0", id, error };
	send(response);
};

export const sendResult = (id: string, result: unknown): void => {
	const response: RpcResponse = { jsonrpc: "2.0", id, result };
	send(response);
};

export const sendAgentEvent = (
	state: RuntimeState,
	runId: string,
	event: AgentEventNotify["event"],
): number | null => {
	if (state.shouldSuppressEvent(runId)) return null;
	const seq = state.nextSequence(runId);
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "agent.event",
		params: {
			run_id: runId,
			seq,
			event,
		} satisfies AgentEventNotify,
	};
	send(notify);
	return seq;
};

export const sendAgentEventAsync = async (
	state: RuntimeState,
	runId: string,
	event: AgentEventNotify["event"],
): Promise<number | null> => {
	if (state.shouldSuppressEvent(runId)) return null;
	const seq = state.nextSequence(runId);
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "agent.event",
		params: {
			run_id: runId,
			seq,
			event,
		} satisfies AgentEventNotify,
	};
	await sendAsync(notify);
	return seq;
};

export const sendRunStatus = (
	runId: string,
	status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled",
	message?: string,
): void => {
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "run.status",
		params: {
			run_id: runId,
			status,
			message,
		},
	};
	send(notify);
};

export const sendRunStatusAsync = async (
	runId: string,
	status: "running" | "awaiting_ui" | "completed" | "error" | "cancelled",
	message?: string,
): Promise<void> => {
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "run.status",
		params: {
			run_id: runId,
			status,
			message,
		},
	};
	await sendAsync(notify);
};

export const sendRunContext = (
	runId: string,
	contextLeftPercent: number,
): void => {
	const notify: RpcNotification = {
		jsonrpc: "2.0",
		method: "run.context",
		params: {
			run_id: runId,
			context_left_percent: contextLeftPercent,
		} satisfies RunContextNotify,
	};
	send(notify);
};
