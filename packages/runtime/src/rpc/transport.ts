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

export const send = (msg: RpcMessage): void => {
	const payload = `${JSON.stringify(msg)}\n`;
	const label = describeRpcMessage(msg);
	const writable = process.stdout.write(payload, (error) => {
		if (error) {
			debugLog(`transport.write.error label=${label} message=${error.message}`);
		}
	});
	if (!writable) {
		debugLog(`transport.backpressure label=${label} bytes=${payload.length}`);
	}
};

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
