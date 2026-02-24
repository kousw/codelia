import type {
	Agent,
	AgentSession,
	RunEventStoreFactory,
	SessionRecord,
	SessionState,
	SessionStateStore,
	SessionStore,
} from "@codelia/core";
import {
	type LlmCallDiagnostics,
	RPC_ERROR_CODE,
	type RunCancelParams,
	type RunDiagnosticsNotify,
	type RunStartParams,
	type RunStartResult,
} from "@codelia/protocol";
import { resolveModelConfig } from "../config";
import { SERVER_NAME, SERVER_VERSION } from "../constants";
import type { RuntimeState } from "../runtime-state";
import {
	isAbortLikeError,
	isTrackedRunEvent,
	logCompactionSnapshot,
	logRunDebug,
	normalizeToolCallHistory,
	summarizeRunEvent,
} from "./run-debug";
import {
	type NormalizedRunInput,
	normalizeRunInput,
	runInputLengthForDebug,
} from "./run-input";
import {
	sendAgentEvent,
	sendError,
	sendResult,
	sendRunContext,
	sendRunDiagnostics,
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
const SESSION_STATE_SAVE_DEBOUNCE_MS = 1500;

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

type PendingLlmRequest = {
	ts: string;
	provider?: string;
	model: string;
};

const toTimestampMs = (value: string): number | null => {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

const summarizeProviderMeta = (value: unknown): string | null => {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "string") {
		return value.length > 80 ? `${value.slice(0, 77)}...` : value;
	}
	if (Array.isArray(value)) {
		return `array(len=${value.length})`;
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const details: string[] = [];
		if (typeof obj.transport === "string") {
			details.push(`transport=${obj.transport}`);
		}
		if (typeof obj.websocket_mode === "string") {
			details.push(`websocket_mode=${obj.websocket_mode}`);
		}
		if (typeof obj.response_id === "string") {
			details.push(`response_id=${obj.response_id}`);
		}
		if (typeof obj.chain_reset === "boolean") {
			details.push(`chain_reset=${obj.chain_reset ? "true" : "false"}`);
		}
		if (typeof obj.fallback_used === "boolean") {
			details.push(`fallback_used=${obj.fallback_used ? "true" : "false"}`);
		}
		if (details.length > 0) {
			return details.join(" ");
		}
		const keys = Object.keys(obj);
		if (keys.length === 0) return "object";
		const shown = keys.slice(0, 4).join(",");
		return keys.length > 4
			? `object(keys=${shown},...)`
			: `object(keys=${shown})`;
	}
	return typeof value;
};

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
		const normalizedMessages = normalizeToolCallHistory(currentMessages);
		if (normalizedMessages !== currentMessages) {
			runtimeAgent.replaceHistoryMessages(normalizedMessages);
			log(`run.cancel normalized history ${runId}`);
		}
	};

	const normalizeRestoredSessionMessages = (
		messages: SessionState["messages"],
		sessionId: string,
	): SessionState["messages"] => {
		const normalizedMessages = normalizeToolCallHistory(messages);
		if (normalizedMessages !== messages) {
			log(`session restore normalized history ${sessionId}`);
		}
		return normalizedMessages;
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
			let normalizedInput: NormalizedRunInput;
			try {
				normalizedInput = normalizeRunInput(params.input);
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: String(error),
				});
				return;
			}

			if (beforeRunStart) {
				try {
					await beforeRunStart();
				} catch (error) {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
						message: `startup onboarding failed: ${String(error)}`,
					});
					return;
				}
			}

			if (state.activeRunId) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_BUSY,
					message: "runtime busy",
				});
				return;
			}

			let runtimeAgent: Agent;
			try {
				runtimeAgent = await getAgent();
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: String(error),
				});
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
						code: RPC_ERROR_CODE.SESSION_LOAD_FAILED,
						message: `session load failed: ${String(error)}`,
					});
					return;
				}
				if (!resumeState) {
					sendError(id, {
						code: RPC_ERROR_CODE.SESSION_NOT_FOUND,
						message: "session not found",
					});
					return;
				}
				const restoredMessages = Array.isArray(resumeState.messages)
					? resumeState.messages
					: [];
				const messages = normalizeRestoredSessionMessages(
					restoredMessages,
					requestedSessionId,
				);
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
					sendError(id, {
						code: RPC_ERROR_CODE.SESSION_LOAD_FAILED,
						message: `session reload failed: ${String(error)}`,
					});
					return;
				}
				if (resumeState) {
					const restoredMessages = Array.isArray(resumeState.messages)
						? resumeState.messages
						: [];
					const messages = normalizeRestoredSessionMessages(
						restoredMessages,
						state.sessionId,
					);
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
			const sessionAppenderRaw = createSessionAppender(
				sessionStore,
				(error, record) => {
					log(`session-store error (${record.type}): ${String(error)}`);
				},
			);
			const pendingLlmRequests = new Map<number, PendingLlmRequest>();
			const emitRunDiagnostics = (params: RunDiagnosticsNotify): void => {
				if (!state.diagnosticsEnabled) return;
				try {
					sendRunDiagnostics(params);
				} catch (error) {
					log(`run diagnostics emit failed: ${String(error)}`);
				}
			};
			const sessionAppend = (record: SessionRecord): void => {
				if (state.diagnosticsEnabled) {
					try {
						if (record.type === "llm.request") {
							const modelName =
								record.model?.name ?? record.input.model ?? "unknown";
							pendingLlmRequests.set(record.seq, {
								ts: record.ts,
								provider: record.model?.provider,
								model: modelName,
							});
						}
						if (record.type === "llm.response") {
							const request = pendingLlmRequests.get(record.seq);
							pendingLlmRequests.delete(record.seq);
							const usage = record.output.usage ?? null;
							const cacheReadTokens = usage?.input_cached_tokens ?? 0;
							const cacheCreationTokens =
								usage?.input_cache_creation_tokens ?? 0;
							const inputTokens = usage?.input_tokens ?? 0;
							const hitState = usage
								? cacheReadTokens > 0
									? "hit"
									: "miss"
								: "unknown";
							const responseTsMs = toTimestampMs(record.ts);
							const requestTsMs = request ? toTimestampMs(request.ts) : null;
							const latencyMs =
								responseTsMs !== null && requestTsMs !== null
									? Math.max(0, responseTsMs - requestTsMs)
									: 0;
							const model = usage?.model ?? request?.model ?? "unknown";
							const diagnostics: LlmCallDiagnostics = {
								run_id: runId,
								seq: record.seq,
								...(request?.provider ? { provider: request.provider } : {}),
								model,
								request_ts: request?.ts ?? record.ts,
								response_ts: record.ts,
								latency_ms: latencyMs,
								stop_reason: record.output.stop_reason ?? null,
								usage,
								cache: {
									hit_state: hitState,
									cache_read_tokens: cacheReadTokens,
									cache_creation_tokens: cacheCreationTokens,
									cache_read_ratio: usage
										? cacheReadTokens / Math.max(inputTokens, 1)
										: null,
								},
								cost_usd: null,
								provider_meta_summary: summarizeProviderMeta(
									record.output.provider_meta,
								),
							};
							emitRunDiagnostics({
								run_id: runId,
								kind: "llm_call",
								call: diagnostics,
							});
						}
					} catch (error) {
						log(`run diagnostics build failed: ${String(error)}`);
					}
				}
				sessionAppenderRaw(record);
			};
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
				let sessionSaveChain = Promise.resolve();
				let lastSessionSaveAt = 0;
				const emitRunSummaryDiagnostics = (): void => {
					emitRunDiagnostics({
						run_id: runId,
						kind: "run_summary",
						summary: runtimeAgent.getUsageSummary(),
					});
				};
				const queueSessionSave = async (reason: string): Promise<void> => {
					sessionSaveChain = sessionSaveChain
						.then(async () => {
							if (!sessionId) return;
							const messages = runtimeAgent.getHistoryMessages();
							const snapshotMessages = normalizeToolCallHistory(messages);
							if (snapshotMessages !== messages) {
								logRunDebug(
									log,
									runId,
									`session.save normalized reason=${reason}`,
								);
							}
							const snapshot = buildSessionState(
								sessionId,
								runId,
								snapshotMessages,
								session.invoke_seq,
							);
							await sessionStateStore.save(snapshot);
							logRunDebug(log, runId, `session.save ${reason}`);
						})
						.catch((error) => {
							log(`Error: session-state save failed: ${String(error)}`);
						});
					await sessionSaveChain;
				};
				const maybeDebouncedSessionSave = (): void => {
					const now = Date.now();
					if (now - lastSessionSaveAt < SESSION_STATE_SAVE_DEBOUNCE_MS) {
						return;
					}
					lastSessionSaveAt = now;
					void queueSessionSave("debounced");
				};
				try {
					logRunDebug(
						log,
						runId,
						`stream.start input_chars=${runInputLengthForDebug(normalizedInput)}`,
					);
					for await (const event of runtimeAgent.runStream(normalizedInput, {
						session,
						signal: runAbortController.signal,
						forceCompaction: params.force_compaction,
					})) {
						if (state.cancelRequested) {
							break;
						}
						if (event.type === "final") {
							finalResponse = event.content;
							await queueSessionSave("final");
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
						maybeDebouncedSessionSave();
					}
					if (state.cancelRequested) {
						normalizeRunHistoryAfterCancel(runId, runtimeAgent);
					}
					await queueSessionSave("terminal");
					emitRunSummaryDiagnostics();
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
						await queueSessionSave("cancelled");
						emitRunSummaryDiagnostics();
						emitRunStatus(runId, "cancelled", err.message || "cancelled");
						emitRunEnd(runId, "cancelled", finalResponse);
						return;
					}
					await queueSessionSave("error");
					emitRunSummaryDiagnostics();
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
					if (state.cancelRequested) {
						normalizeRunHistoryAfterCancel(runId, runtimeAgent);
					}
					await queueSessionSave("finally");
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
		sendError(id, {
			code: RPC_ERROR_CODE.RUN_NOT_FOUND,
			message: "run not found",
		});
	};

	return { handleRunStart, handleRunCancel };
};
