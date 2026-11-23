import { AsyncLocalStorage } from "node:async_hooks";
import type {
	AgentEventNotify,
	RpcError,
	RpcMessage,
	RpcNotification,
	RpcResponse,
	RunDiagnosticsNotify,
	RunMetricsNotify,
	RunStatusNotify,
} from "@codelia/protocol";
import { debugLog, log } from "../logger";
import type { RuntimeState } from "../runtime-state";
import { notificationMessage } from "./protocol";

type ResponseContext = { id: string; sent: boolean };
const responseContext = new AsyncLocalStorage<ResponseContext>();

export const withRpcResponseContext = <T>(id: string, callback: () => T): T =>
	responseContext.run({ id, sent: false }, callback);

export const hasRpcResponse = (id: string): boolean => {
	const current = responseContext.getStore();
	return current?.id === id && current.sent;
};

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

const hostNotificationQueues = new WeakMap<RuntimeState, Promise<void>>();

const enqueueHostNotification = (
	state: RuntimeState,
	notify: RpcNotification,
): Promise<void> => {
	const sink = state.effectiveEnvironment.adapters.eventSink;
	if (!sink) {
		log(
			`transport.host-event.error label=${describeRpcMessage(notify)} message=event sink unavailable`,
		);
		return Promise.resolve();
	}
	const previous = hostNotificationQueues.get(state) ?? Promise.resolve();
	const next = previous
		.then(() => sink.emit(notify))
		.catch((error) => {
			log(
				`transport.host-event.error label=${describeRpcMessage(notify)} message=${String(error)}`,
			);
		});
	hostNotificationQueues.set(state, next);
	return next;
};

const sendNotification = (
	state: RuntimeState,
	notify: RpcNotification,
): void => {
	if (state.effectiveEnvironment.events.live === "host") {
		void enqueueHostNotification(state, notify);
		return;
	}
	send(notify);
};

export const sendNotificationAsync = async (
	state: RuntimeState,
	notify: RpcNotification,
): Promise<void> => {
	if (state.effectiveEnvironment.events.live === "host") {
		await enqueueHostNotification(state, notify);
		return;
	}
	await sendAsync(notify);
};

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
	sendResponse(response);
};

export const sendResult = (id: string, result: unknown): void => {
	const response: RpcResponse = { jsonrpc: "2.0", id, result };
	sendResponse(response);
};

const sendResponse = (response: RpcResponse): void => {
	const current = responseContext.getStore();
	if (current?.id === response.id && current.sent) {
		debugLog(`transport.duplicate-response id=${response.id}`);
		return;
	}
	send(response);
	if (current?.id === response.id) current.sent = true;
};

export const sendAgentEvent = (
	state: RuntimeState,
	runId: string,
	event: AgentEventNotify["event"],
): number | null => {
	if (state.shouldSuppressEvent(runId)) return null;
	const seq = state.nextSequence(runId);
	sendNotification(
		state,
		notificationMessage("agent.event", { run_id: runId, seq, event }),
	);
	return seq;
};

export const sendAgentEventAsync = async (
	state: RuntimeState,
	runId: string,
	event: AgentEventNotify["event"],
): Promise<number | null> => {
	if (state.shouldSuppressEvent(runId)) return null;
	const seq = state.nextSequence(runId);
	await sendNotificationAsync(
		state,
		notificationMessage("agent.event", { run_id: runId, seq, event }),
	);
	return seq;
};

export const sendRunStatus = (
	state: RuntimeState,
	runId: string,
	status: RunStatusNotify["status"],
	message?: string,
	error?: RunStatusNotify["error"],
	extras?: Pick<RunStatusNotify, "unconsumed_steer_ids">,
): void => {
	const notify = notificationMessage("run.status", {
		run_id: runId,
		status,
		message,
		...(error ? { error } : {}),
		...(extras?.unconsumed_steer_ids?.length
			? { unconsumed_steer_ids: extras.unconsumed_steer_ids }
			: {}),
	});
	sendNotification(state, notify);
};

export const sendRunStatusAsync = async (
	state: RuntimeState,
	runId: string,
	status: RunStatusNotify["status"],
	message?: string,
	error?: RunStatusNotify["error"],
): Promise<void> => {
	const notify = notificationMessage("run.status", {
		run_id: runId,
		status,
		message,
		...(error ? { error } : {}),
	});
	await sendNotificationAsync(state, notify);
};

export const sendRunContext = (
	state: RuntimeState,
	runId: string,
	contextLeftPercent: number,
): void => {
	sendNotification(
		state,
		notificationMessage("run.context", {
			run_id: runId,
			context_left_percent: contextLeftPercent,
		}),
	);
};

export const sendRunDiagnostics = (
	state: RuntimeState,
	params: RunDiagnosticsNotify,
): void => {
	sendNotification(state, notificationMessage("run.diagnostics", params));
};

export const sendRunMetrics = (
	state: RuntimeState,
	params: RunMetricsNotify,
): void => {
	sendNotification(state, notificationMessage("run.metrics", params));
};
