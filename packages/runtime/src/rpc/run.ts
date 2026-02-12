import type {
	Agent,
	AgentSession,
	RunEventStoreFactory,
	SessionRecord,
	SessionState,
	SessionStateStore,
	SessionStore,
} from "@codelia/core";
import type {
	RunCancelParams,
	RunStartParams,
	RunStartResult,
} from "@codelia/protocol";
import { resolveModelConfig } from "../config";
import { SERVER_NAME, SERVER_VERSION } from "../constants";
import type { RuntimeState } from "../runtime-state";
import {
	isAbortLikeError,
	isTrackedRunEvent,
	logCompactionSnapshot,
	logRunDebug,
	normalizeCancelledHistory,
	summarizeRunEvent,
} from "./run-debug";
import { prepareRunInputText } from "./skill-mentions";
import {
	sendAgentEvent,
	sendError,
	sendResult,
	sendRunContext,
	sendRunStatus,
} from "./transport";

export type RunHandlersDeps = {
	state: RuntimeState;
	getAgent: () => Promise<Agent>;
	log: (message: string) => void;
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
	appendSession: (record: SessionRecord) => void;
	beforeRunStart?: () => Promise<void>;
};

const nowIso = (): string => new Date().toISOString();

const createSessionAppender = (
	store: SessionStore,
	onError: (error: unknown, record: SessionRecord) => void,
): ((record: SessionRecord) => void) => {
	let chain = Promise.resolve();
	return (record: SessionRecord): void => {
		chain = chain
			.then(() => store.append(record))
			.catch((error) => {
				onError(error, record);
			});
	};
};

const buildSessionState = (
	sessionId: string,
	runId: string,
	messages: SessionState["messages"],
	invokeSeq?: number,
): SessionState => ({
	schema_version: 1,
	session_id: sessionId,
	updated_at: nowIso(),
	run_id: runId,
	invoke_seq: invokeSeq,
	messages,
});

export const createRunHandlers = ({
	state,
	getAgent,
	log,
	runEventStoreFactory,
	sessionStateStore,
	appendSession,
	beforeRunStart,
}: RunHandlersDeps): {
	handleRunStart: (id: string, params: RunStartParams) => Promise<void>;
	handleRunCancel: (id: string, params: RunCancelParams) => void;
} => {
	let activeRunAbort: {
		runId: string;
		controller: AbortController;
	} | null = null;
	let runStartQueue = Promise.resolve();

	const normalizeRunHistoryAfterCancel = (
		runId: string,
		runtimeAgent: Agent,
	): void => {
		const currentMessages = runtimeAgent.getHistoryMessages();
		const normalizedMessages = normalizeCancelledHistory(currentMessages);
		if (normalizedMessages !== currentMessages) {
			runtimeAgent.replaceHistoryMessages(normalizedMessages);
			log(`run.cancel normalized history ${runId}`);
		}
	};

	const emitRunStatus = (
		runId: string,
		status: "running" | "completed" | "cancelled" | "error",
		message?: string,
	): void => {
		sendRunStatus(runId, status, message);
		const suffix = message ? ` message=${message}` : "";
		logRunDebug(log, runId, `status=${status} sent${suffix}`);
		appendSession({
			type: "run.status",
			run_id: runId,
			ts: nowIso(),
			status,
			...(message ? { message } : {}),
		});
	};

	const emitRunEnd = (
		runId: string,
		outcome: "completed" | "cancelled" | "error",
		final?: string,
	): void => {
		appendSession({
			type: "run.end",
			run_id: runId,
			ts: nowIso(),
			outcome,
			...(final !== undefined ? { final } : {}),
		});
	};

	const handleRunStart = (
		id: string,
		params: RunStartParams,
	): Promise<void> => {
		const run = async (): Promise<void> => {
			if (beforeRunStart) {
				try {
					await beforeRunStart();
				} catch (error) {
					sendError(id, {
						code: -32000,
						message: `startup onboarding failed: ${String(error)}`,
					});
					return;
				}
			}

			if (state.activeRunId) {
				sendError(id, { code: -32001, message: "runtime busy" });
				return;
			}

			let runtimeAgent: Agent;
			try {
				runtimeAgent = await getAgent();
			} catch (error) {
				sendError(id, { code: -32000, message: String(error) });
				return;
			}

			const requestedSessionId = params.session_id?.trim() || undefined;
			let resumeState: SessionState | null = null;
			let sessionId =
				requestedSessionId ?? state.sessionId ?? state.nextSessionId();
			if (requestedSessionId && requestedSessionId !== state.sessionId) {
				try {
					resumeState = await sessionStateStore.load(requestedSessionId);
				} catch (error) {
					sendError(id, {
						code: -32005,
						message: `session load failed: ${String(error)}`,
					});
					return;
				}
				if (!resumeState) {
					sendError(id, { code: -32004, message: "session not found" });
					return;
				}
				const messages = Array.isArray(resumeState.messages)
					? resumeState.messages
					: [];
				runtimeAgent.replaceHistoryMessages(messages);
				sessionId = requestedSessionId;
				state.sessionId = sessionId;
			} else if (
				state.sessionId &&
				runtimeAgent.getHistoryMessages().length === 0
			) {
				try {
					resumeState = await sessionStateStore.load(state.sessionId);
				} catch (error) {
					log(`session state reload error: ${String(error)}`);
				}
				if (resumeState) {
					const messages = Array.isArray(resumeState.messages)
						? resumeState.messages
						: [];
					runtimeAgent.replaceHistoryMessages(messages);
				}
			} else if (!state.sessionId) {
				state.sessionId = sessionId;
			}

			const runId = state.nextRunId();
			const startedAt = nowIso();
			state.beginRun(runId, params.ui_context ?? state.lastUiContext);
			const runAbortController = new AbortController();
			activeRunAbort = { runId, controller: runAbortController };
			const sessionStore = runEventStoreFactory.create({ runId, startedAt });
			const sessionAppend = createSessionAppender(
				sessionStore,
				(error, record) => {
					log(`session-store error (${record.type}): ${String(error)}`);
				},
			);
			state.sessionAppend = sessionAppend;
			const session: AgentSession = {
				run_id: runId,
				session_id: sessionId,
				invoke_seq: resumeState?.invoke_seq,
				append: sessionAppend,
			};
			let modelConfig: Awaited<ReturnType<typeof resolveModelConfig>> | null =
				null;
			try {
				modelConfig = await resolveModelConfig();
			} catch (error) {
				log(`session header model config error: ${error}`);
			}
			appendSession({
				type: "header",
				schema_version: 1,
				run_id: runId,
				session_id: sessionId,
				started_at: startedAt,
				client: state.lastClientInfo ?? undefined,
				server: { name: SERVER_NAME, version: SERVER_VERSION },
				model: modelConfig
					? {
							provider: modelConfig.provider,
							name: modelConfig.name,
							reasoning: modelConfig.reasoning,
						}
					: undefined,
				prompts: state.systemPrompt
					? { system: state.systemPrompt }
					: undefined,
				tools: state.toolDefinitions
					? { definitions: state.toolDefinitions, source: "runtime" }
					: undefined,
				runtime: {
					cwd: state.lastUiContext?.cwd,
					os: process.platform,
					arch: process.arch,
					version: SERVER_VERSION,
				},
			});
			appendSession({
				type: "run.start",
				run_id: runId,
				session_id: sessionId,
				ts: nowIso(),
				input: params.input,
				ui_context: params.ui_context,
				meta: params.meta,
			});
			const result: RunStartResult = { run_id: runId };
			sendResult(id, result);
			log(`run.start ${runId}`);
			emitRunStatus(runId, "running");

			void (async () => {
				let finalResponse: string | undefined;
				let cancelledWhileStreaming = false;
				const preparedInputText = prepareRunInputText(params.input.text);
				try {
					logRunDebug(
						log,
						runId,
						`stream.start input_chars=${preparedInputText.length}`,
					);
					for await (const event of runtimeAgent.runStream(preparedInputText, {
						session,
						signal: runAbortController.signal,
						forceCompaction: params.force_compaction,
					})) {
						if (state.cancelRequested) {
							cancelledWhileStreaming = true;
							break;
						}
						if (event.type === "final") {
							finalResponse = event.content;
						}
						if (event.type === "compaction_complete") {
							logCompactionSnapshot(log, runId, runtimeAgent, event.compacted);
						}
						if (isTrackedRunEvent(event.type)) {
							logRunDebug(
								log,
								runId,
								`event.received ${summarizeRunEvent(event)}`,
							);
						}
						const seq = sendAgentEvent(state, runId, event);
						if (isTrackedRunEvent(event.type)) {
							logRunDebug(
								log,
								runId,
								`event.sent ${event.type} seq=${seq === null ? "suppressed" : String(seq)}`,
							);
						}
						if (seq !== null) {
							appendSession({
								type: "agent.event",
								run_id: runId,
								ts: nowIso(),
								seq,
								event,
							});
						}
						const contextLeftPercent = runtimeAgent.getContextLeftPercent();
						if (
							contextLeftPercent !== null &&
							state.updateContextLeftPercent(contextLeftPercent)
						) {
							sendRunContext(runId, contextLeftPercent);
							appendSession({
								type: "run.context",
								run_id: runId,
								ts: nowIso(),
								context_left_percent: contextLeftPercent,
							});
						}
					}
					if (cancelledWhileStreaming) {
						normalizeRunHistoryAfterCancel(runId, runtimeAgent);
					}
					const status = state.cancelRequested ? "cancelled" : "completed";
					emitRunStatus(runId, status);
					emitRunEnd(
						runId,
						status === "completed" ? "completed" : "cancelled",
						finalResponse,
					);
				} catch (error) {
					const err = error instanceof Error ? error : new Error(String(error));
					if (state.cancelRequested || isAbortLikeError(err)) {
						normalizeRunHistoryAfterCancel(runId, runtimeAgent);
						emitRunStatus(runId, "cancelled", err.message || "cancelled");
						emitRunEnd(runId, "cancelled", finalResponse);
						return;
					}
					emitRunStatus(runId, "error", err.message);
					appendSession({
						type: "run.error",
						run_id: runId,
						ts: nowIso(),
						error: {
							name: err.name,
							message: err.message,
							stack: err.stack,
						},
					});
					emitRunEnd(runId, "error");
				} finally {
					logRunDebug(log, runId, "stream.finally");
					if (state.sessionId) {
						const messages = runtimeAgent.getHistoryMessages();
						const snapshot = buildSessionState(
							sessionId,
							runId,
							messages,
							session.invoke_seq,
						);
						void sessionStateStore.save(snapshot).catch((error) => {
							log(`session-state error: ${String(error)}`);
						});
					}
					if (activeRunAbort?.runId === runId) {
						activeRunAbort = null;
					}
					state.finishRun(runId);
				}
			})();
		};
		const queued = runStartQueue.then(run, run);
		runStartQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	const handleRunCancel = (id: string, params: RunCancelParams): void => {
		if (state.cancelRun(params.run_id)) {
			if (activeRunAbort?.runId === params.run_id) {
				activeRunAbort.controller.abort(
					new Error(params.reason ?? "cancelled by user"),
				);
			}
			sendResult(id, { ok: true });
			log(`run.cancel ${params.run_id} (${params.reason ?? "no reason"})`);
			return;
		}
		sendError(id, { code: -32002, message: "run not found" });
	};

	return { handleRunStart, handleRunCancel };
};
