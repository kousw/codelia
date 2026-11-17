import type {
	Agent,
	AgentSession,
	PolledMessage,
	RunEventStoreFactory,
	SessionRecord,
	SessionState,
	SessionStateStore,
	SessionStore,
	ToolChoice,
} from "@codelia/core";
import {
	type LlmCallDiagnostics,
	RPC_ERROR_CODE,
	type RunCancelParams,
	type RunDiagnosticsNotify,
	type RunStartParams,
	type RunStartResult,
	type RunStatusNotify,
	type RunSteerParams,
	type RunSteerResult,
	type SessionOpenParams,
	type SessionOpenResult,
} from "@codelia/protocol";
import { SERVER_NAME, SERVER_VERSION } from "../constants";
import {
	applySessionModelOverrideFromMeta,
	mergeSessionModelOverrideIntoMeta,
	resolveEffectiveModelConfig,
} from "../effective-model";
import { normalizeRunFailure } from "../provider-errors";
import type { PendingRunSteer, RuntimeState } from "../runtime-state";
import { createClientToolAdapters } from "../tools/client";
import {
	clearTodosForSession,
	getTodosForSession,
	mergeTodosIntoSessionMeta,
	readTodosFromSessionMeta,
	setTodosForSession,
} from "../tools/todo-store";
import { createRunContextUsageEmitter } from "./context-usage";
import {
	buildResumeDiff,
	injectResumeDiffSystemReminder,
	mergeResumeContextIntoSessionMeta,
	prependCurrentStartupSystemMessage,
	stripResumeDiffSystemMessages,
	stripStartupSystemMessages,
} from "./resume-context";
import {
	isAbortLikeError,
	isTrackedRunEvent,
	logCompactionSnapshot,
	logRunDebug,
	normalizeToolCallHistory,
	summarizeProviderMeta,
	summarizeRunEvent,
} from "./run-debug";
import {
	AttachmentAdmissionError,
	isRunInputEmpty,
	type NormalizedRunInput,
	normalizeRunInput,
	resolveRunInputAttachments,
	runAttachmentIds,
	runInputLengthForDebug,
	type UnresolvedRunInput,
} from "./run-input";
import { buildRunMetrics } from "./run-metrics";
import {
	createTextDeltaCoalescer,
	isStreamDeltaEvent,
} from "./text-delta-coalescer";
import {
	sendAgentEvent,
	sendError,
	sendResult,
	sendRunContext,
	sendRunDiagnostics,
	sendRunMetrics,
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
const SESSION_WORKSPACE_ROOT_META_KEY = "codelia_workspace_root";

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
	meta?: Record<string, unknown>,
): SessionState => ({
	schema_version: 1,
	session_id: sessionId,
	updated_at: nowIso(),
	run_id: runId,
	invoke_seq: invokeSeq,
	messages,
	meta,
});

const toMetaObject = (value: unknown): Record<string, unknown> | undefined => {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	return { ...(value as Record<string, unknown>) };
};

const mergeWorkspaceRootIntoSessionMeta = (
	meta: Record<string, unknown> | undefined,
	workspaceRoot: string | undefined,
): Record<string, unknown> | undefined => {
	const nextMeta = meta ? { ...meta } : {};
	const trimmedWorkspaceRoot = workspaceRoot?.trim();
	if (trimmedWorkspaceRoot) {
		nextMeta[SESSION_WORKSPACE_ROOT_META_KEY] = trimmedWorkspaceRoot;
	} else {
		delete nextMeta[SESSION_WORKSPACE_ROOT_META_KEY];
	}
	return Object.keys(nextMeta).length > 0 ? nextMeta : undefined;
};

export const resolveSessionWorkspaceRoot = (
	state: Pick<
		RuntimeState,
		| "lastUiContext"
		| "agentsResolver"
		| "runtimeSandboxRoot"
		| "runtimeWorkingDir"
	>,
): string | undefined =>
	state.lastUiContext?.workspace_root ??
	state.agentsResolver?.getRootDir() ??
	state.runtimeSandboxRoot ??
	state.runtimeWorkingDir ??
	undefined;

type PendingLlmRequest = {
	ts: string;
	provider?: string;
	model: string;
};

const toTimestampMs = (value: string): number | null => {
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

const OPENAI_AUTO_WS_FALLBACK_WARNING =
	"Warning: OpenAI websocket auto mode fell back to HTTP. Continuing this run over HTTP.";

const shouldEmitOpenAiWsFallbackWarning = (providerMeta: unknown): boolean => {
	if (
		!providerMeta ||
		typeof providerMeta !== "object" ||
		Array.isArray(providerMeta)
	) {
		return false;
	}
	const meta = providerMeta as Record<string, unknown>;
	return (
		meta.transport === "http_stream" &&
		meta.websocket_mode === "auto" &&
		meta.fallback_used === true
	);
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
	handleRunSteer: (id: string, params: RunSteerParams) => Promise<void>;
	handleRunCancel: (id: string, params: RunCancelParams) => void;
	handleSessionOpen: (id: string, params: SessionOpenParams) => Promise<void>;
	afterSessionOpen: <T>(task: () => Promise<T>) => Promise<T>;
} => {
	let activeRunAbort: {
		runId: string;
		controller: AbortController;
		agent: Agent;
		toolChoice?: ToolChoice;
	} | null = null;
	const steerAttachments = new Map<
		string,
		{ ids: string[]; release: () => void }
	>();
	const releaseSteerAttachments = (steerId: string): void => {
		steerAttachments.get(steerId)?.release();
		steerAttachments.delete(steerId);
	};
	let runStartQueue = Promise.resolve();
	let runSteerQueue = Promise.resolve();
	let sessionOpenSettled = Promise.resolve();

	const normalizeRuntimeAgentHistory = (
		label: string,
		runtimeAgent: Agent,
	): void => {
		const currentMessages = runtimeAgent.getHistoryMessages();
		const normalizedMessages = normalizeToolCallHistory(currentMessages);
		if (normalizedMessages !== currentMessages) {
			runtimeAgent.replaceHistoryMessages(normalizedMessages);
			log(`${label} normalized history`);
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

	const restoreSessionHistoryIntoAgent = async (options: {
		runtimeAgent: Agent;
		resumeState: SessionState;
		sessionId: string;
	}): Promise<void> => {
		const restoredMessages = Array.isArray(options.resumeState.messages)
			? options.resumeState.messages
			: [];
		const messages = normalizeRestoredSessionMessages(
			stripStartupSystemMessages(
				stripResumeDiffSystemMessages(restoredMessages),
			),
			options.sessionId,
		);
		const resumeDiff = await buildResumeDiff(options.resumeState.meta, state);
		const restoredWithCurrentStartup = prependCurrentStartupSystemMessage(
			messages,
			state.systemPrompt,
		);
		options.runtimeAgent.replaceHistoryMessages(
			resumeDiff
				? injectResumeDiffSystemReminder(
						restoredWithCurrentStartup,
						resumeDiff.systemReminder,
					)
				: restoredWithCurrentStartup,
		);
	};

	const emitRunStatus = (
		runId: string,
		status: "running" | "completed" | "cancelled" | "error",
		message?: string,
		error?: RunStatusNotify["error"],
		extras?: Pick<RunStatusNotify, "unconsumed_steer_ids">,
	): void => {
		sendRunStatus(state, runId, status, message, error, extras);
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
		let admittedRunId: string | null = null;
		let responseSent = false;
		const run = async (): Promise<void> => {
			let initialInput: UnresolvedRunInput;
			try {
				initialInput = normalizeRunInput(params.input);
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: String(error),
				});
				return;
			}
			const attachmentIds = runAttachmentIds(initialInput);
			if (params.force_compaction && attachmentIds.length > 0) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "A compaction run cannot admit new attachments",
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

			const requestedSessionId = params.session_id?.trim() || undefined;
			let resumeState: SessionState | null = null;
			const previousSessionId = state.sessionId;
			const previousModelOverride = state.sessionModelOverride;
			const freshSession = !requestedSessionId && !previousSessionId;
			let sessionId =
				requestedSessionId ?? state.sessionId ?? state.nextSessionId();
			let loadedSessionState = false;
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
				applySessionModelOverrideFromMeta(state, resumeState.meta);
			} else if (state.sessionId) {
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
					applySessionModelOverrideFromMeta(state, resumeState.meta);
				}
			}

			if (resumeState?.meta?.codelia_subagent) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Delegated sessions cannot be resumed as a root run",
				});
				return;
			}
			let runtimeAgent: Agent;
			let normalizedInput: NormalizedRunInput;
			try {
				runtimeAgent = await getAgent();
				normalizedInput = await resolveRunInputAttachments(initialInput, {
					service: state.attachments,
					sessionId,
					allowDraft: freshSession,
					canReadAttachment: state.canReadAttachment,
					canUseVision: () => runtimeAgent.canUseVisualAttachments(),
					canPersistInlineImages: !!state.prepareRunImages,
					toolChoice: params.tool_choice,
				});
				if (!params.force_compaction && state.prepareRunImages) {
					normalizedInput = await state.prepareRunImages(normalizedInput);
				}
			} catch (error) {
				state.sessionModelOverride = previousModelOverride;
				sendError(id, {
					code:
						error instanceof AttachmentAdmissionError
							? RPC_ERROR_CODE.INVALID_PARAMS
							: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			const runId = state.nextRunId();
			let clientTools: ReturnType<typeof createClientToolAdapters>;
			try {
				clientTools = createClientToolAdapters({
					runId,
					tools: params.tools,
					state,
					existingTools: state.tools ?? [],
				});
			} catch (error) {
				state.sessionModelOverride = previousModelOverride;
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: String(error),
				});
				return;
			}
			if (attachmentIds.length > 0) {
				try {
					await state.attachments?.claim(attachmentIds, sessionId, {
						allowDraft: freshSession,
					});
				} catch {
					state.sessionModelOverride = previousModelOverride;
					sendError(id, {
						code: RPC_ERROR_CODE.INVALID_PARAMS,
						message:
							"Could not claim the attachments for this conversation. Upload them again.",
					});
					return;
				}
			}
			if (resumeState && sessionStateStore.updateMetadata)
				await sessionStateStore.updateMetadata(sessionId, { archived: false });
			normalizeRuntimeAgentHistory("run.start preflight", runtimeAgent);
			if (requestedSessionId && requestedSessionId !== state.sessionId) {
				await restoreSessionHistoryIntoAgent({
					runtimeAgent,
					resumeState: resumeState as SessionState,
					sessionId: requestedSessionId,
				});
				sessionId = requestedSessionId;
				state.attachments?.discardDraft();
				state.sessionId = sessionId;
				loadedSessionState = true;
			} else if (
				state.sessionId &&
				runtimeAgent.getHistoryMessages().length === 0
			) {
				if (resumeState) {
					await restoreSessionHistoryIntoAgent({
						runtimeAgent,
						resumeState,
						sessionId: state.sessionId,
					});
					loadedSessionState = true;
				}
			} else if (!state.sessionId) {
				state.attachments?.bindDraft(sessionId);
				state.sessionId = sessionId;
			}
			const switchedSession = previousSessionId !== sessionId;
			if (loadedSessionState && resumeState) {
				const restoredTodos = readTodosFromSessionMeta(resumeState.meta);
				if (restoredTodos.length > 0) {
					setTodosForSession(sessionId, restoredTodos);
				} else {
					clearTodosForSession(sessionId);
				}
				state.sessionMeta = toMetaObject(resumeState.meta) ?? null;
			} else if (switchedSession) {
				clearTodosForSession(sessionId);
				state.sessionMeta = null;
			}
			const runMeta = toMetaObject(params.meta);
			if (runMeta) {
				state.sessionMeta = {
					...(state.sessionMeta ?? {}),
					...runMeta,
				};
			}

			state.autoApprovedClientToolNames = new Set(
				(params.tools ?? [])
					.filter((tool) => tool.approval === "never")
					.map((tool) => tool.name),
			);
			const startedAt = nowIso();
			state.beginRun(runId, params.ui_context ?? state.lastUiContext);
			admittedRunId = runId;
			const runAbortController = new AbortController();
			state.activeRunSignal = runAbortController.signal;
			activeRunAbort = {
				runId,
				controller: runAbortController,
				agent: runtimeAgent,
				toolChoice: params.tool_choice,
			};
			const sessionStore = runEventStoreFactory.create({ runId, startedAt });
			const sessionAppenderRaw = createSessionAppender(
				sessionStore,
				(error, record) => {
					log(`session-store error (${record.type}): ${String(error)}`);
				},
			);
			const pendingLlmRequests = new Map<number, PendingLlmRequest>();
			let openAiWsFallbackWarningShown = false;
			// Provisional deltas only for clients that opted in; never persisted.
			const streamDeltas = state.uiCapabilities?.supports_text_delta === true;
			const deltaCoalescer = streamDeltas
				? createTextDeltaCoalescer({
						send: (event) => {
							if (!state.cancelRequested) sendAgentEvent(state, runId, event);
						},
					})
				: null;
			const emitRunDiagnostics = (params: RunDiagnosticsNotify): void => {
				if (!state.diagnosticsEnabled) return;
				try {
					sendRunDiagnostics(state, params);
				} catch (error) {
					log(`run diagnostics emit failed: ${String(error)}`);
				}
			};
			const emitOpenAiWsFallbackWarning = (): void => {
				if (openAiWsFallbackWarningShown) {
					return;
				}
				openAiWsFallbackWarningShown = true;
				deltaCoalescer?.flush();
				try {
					const event = {
						type: "text" as const,
						content: OPENAI_AUTO_WS_FALLBACK_WARNING,
						timestamp: Date.now(),
					};
					const seq = sendAgentEvent(state, runId, event);
					if (seq !== null) {
						appendSession({
							type: "agent.event",
							run_id: runId,
							ts: nowIso(),
							seq,
							event,
						});
					}
				} catch (error) {
					openAiWsFallbackWarningShown = false;
					log(`openai ws fallback warning emit failed: ${String(error)}`);
				}
			};
			const sessionAppend = (record: SessionRecord): void => {
				if (record.type === "llm.response") {
					try {
						sendRunMetrics(state, buildRunMetrics(record));
					} catch (error) {
						log(`run metrics emit failed: ${String(error)}`);
					}
				}
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
							const metrics = buildRunMetrics(record);
							const diagnostics: LlmCallDiagnostics = {
								run_id: runId,
								seq: record.seq,
								...(request?.provider ? { provider: request.provider } : {}),
								model,
								request_ts: request?.ts ?? record.ts,
								response_ts: record.ts,
								latency_ms: latencyMs,
								...(metrics.timing ? { timing: metrics.timing } : {}),
								output_tokens_per_second: metrics.output_tokens_per_second,
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
				if (
					record.type === "llm.response" &&
					shouldEmitOpenAiWsFallbackWarning(record.output.provider_meta)
				) {
					emitOpenAiWsFallbackWarning();
				}
				sessionAppenderRaw(record);
			};
			state.sessionAppend = sessionAppend;
			const session: AgentSession = {
				run_id: runId,
				session_id: sessionId,
				invoke_seq: resumeState?.invoke_seq,
				append: sessionAppend,
				...(sessionStateStore.appendMessages
					? {
							recordMessages: async (messages) => {
								await sessionStateStore.appendMessages?.(sessionId, messages);
							},
						}
					: {}),
			};
			let modelConfig: Awaited<
				ReturnType<typeof resolveEffectiveModelConfig>
			> | null = null;
			try {
				const workingDir =
					state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined;
				modelConfig = await resolveEffectiveModelConfig(state, workingDir);
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
							source: modelConfig.source,
							...(modelConfig.fast !== undefined
								? { fast: modelConfig.fast }
								: {}),
						}
					: undefined,
				prompts: state.systemPrompt
					? { system: state.systemPrompt }
					: undefined,
				tools: state.toolDefinitions
					? {
							definitions: [
								...state.toolDefinitions,
								...clientTools.map((tool) => tool.definition),
							],
							source: clientTools.length ? "runtime+client" : "runtime",
						}
					: undefined,
				runtime: {
					cwd: state.lastUiContext?.cwd,
					os: process.platform,
					arch: process.arch,
					version: SERVER_VERSION,
				},
				meta: {
					runtime_environment: state.effectiveEnvironment.summary,
				},
			});
			appendSession({
				type: "run.start",
				run_id: runId,
				session_id: sessionId,
				ts: nowIso(),
				input:
					Array.isArray(normalizedInput) &&
					normalizedInput.some(
						(part) =>
							part.type === "image_ref" || part.type === "attachment_ref",
					)
						? { type: "parts", parts: normalizedInput }
						: params.input.type === "text"
							? params.input
							: {
									type: "parts",
									parts: params.input.parts.filter(
										(part) => part.type !== "attachment_ref",
									),
								},
				ui_context: params.ui_context,
				meta: params.meta,
			});
			const result: RunStartResult = {
				run_id: runId,
				session_id: sessionId,
				...(sessionStore.filePath
					? { session_log_path: sessionStore.filePath }
					: {}),
			};
			sendResult(id, result);
			responseSent = true;
			log(`run.start ${runId}`);
			emitRunStatus(runId, "running");

			void (async () => {
				let finalResponse: string | undefined;
				let sessionSaveChain = Promise.resolve();
				let lastSessionSaveAt = 0;
				const polledUnconfirmedSteers: PendingRunSteer[] = [];
				const emitRunSummaryDiagnostics = (): void => {
					emitRunDiagnostics({
						run_id: runId,
						kind: "run_summary",
						summary: runtimeAgent.getUsageSummary(),
					});
				};
				const buildTerminalStatusExtras = ():
					| Pick<RunStatusNotify, "unconsumed_steer_ids">
					| undefined => {
					state.closeRunSteers(runId);
					const remainingSteers = state.drainRunSteers(runId);
					const seenSteerIds = new Set<string>();
					const unconsumedSteerIds: string[] = [];
					for (const steer of [
						...polledUnconfirmedSteers,
						...remainingSteers,
					]) {
						if (seenSteerIds.has(steer.steer_id)) continue;
						seenSteerIds.add(steer.steer_id);
						unconsumedSteerIds.push(steer.steer_id);
						releaseSteerAttachments(steer.steer_id);
					}
					polledUnconfirmedSteers.length = 0;
					if (unconsumedSteerIds.length === 0) {
						return undefined;
					}
					return { unconsumed_steer_ids: unconsumedSteerIds };
				};
				const queueSessionSave = async (reason: string): Promise<void> => {
					sessionSaveChain = sessionSaveChain
						.then(async () => {
							if (!sessionId) return;
							const messages = runtimeAgent.getHistoryMessages();
							const snapshotMessages = normalizeToolCallHistory(
								stripStartupSystemMessages(
									stripResumeDiffSystemMessages(messages),
								),
							);
							if (snapshotMessages !== messages) {
								logRunDebug(
									log,
									runId,
									`session.save normalized reason=${reason}`,
								);
							}
							const sessionMeta = mergeTodosIntoSessionMeta(
								state.sessionMeta ?? undefined,
								getTodosForSession(sessionId),
							);
							const sessionMetaWithModelOverride =
								mergeSessionModelOverrideIntoMeta(
									sessionMeta,
									state.sessionModelOverride,
								);
							const workspaceRoot = resolveSessionWorkspaceRoot(state);
							const sessionMetaWithWorkspace =
								mergeWorkspaceRootIntoSessionMeta(
									sessionMetaWithModelOverride,
									workspaceRoot,
								);
							const sessionMetaWithResumeContext =
								mergeResumeContextIntoSessionMeta(
									sessionMetaWithWorkspace,
									state,
								);
							const snapshot = buildSessionState(
								sessionId,
								runId,
								snapshotMessages,
								session.invoke_seq,
								sessionMetaWithResumeContext,
							);
							await sessionStateStore.save(snapshot);
							state.sessionMeta = sessionMetaWithResumeContext ?? null;
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
					const pollMessages = async (): Promise<PolledMessage[]> => {
						if (runAbortController.signal.aborted || state.cancelRequested) {
							return [];
						}
						const hidden = state.subagentMessages
							? await state.subagentMessages(
									sessionId,
									runAbortController.signal,
								)
							: [];
						if (runAbortController.signal.aborted || state.cancelRequested) {
							return [];
						}
						const polled: PolledMessage[] = [];
						const drainedSteers = state.drainRunSteers(runId);
						polledUnconfirmedSteers.push(...drainedSteers);
						const attachmentsToClaim = drainedSteers.flatMap(
							(steer) => steerAttachments.get(steer.steer_id)?.ids ?? [],
						);
						if (attachmentsToClaim.length > 0) {
							try {
								await state.attachments?.claim(attachmentsToClaim, sessionId);
							} catch {
								throw new Error(
									"Could not apply the steered attachments. Upload them again for this conversation.",
								);
							}
							if (runAbortController.signal.aborted || state.cancelRequested)
								return [];
						}
						for (const steer of drainedSteers) {
							polled.push({
								kind: "steer",
								steer_id: steer.steer_id,
								content: steer.content,
							});
						}
						for (const message of hidden) {
							polled.push({ kind: "hidden", content: message });
						}
						return polled;
					};
					const emitContextUsage = createRunContextUsageEmitter({
						state,
						runId,
						agent: runtimeAgent,
						log,
					});
					for await (const event of runtimeAgent.runStream(normalizedInput, {
						session,
						pollMessages,
						signal: runAbortController.signal,
						forceCompaction: params.force_compaction,
						tools: clientTools,
						toolChoice: params.tool_choice as ToolChoice | undefined,
						...(streamDeltas ? { streamDeltas: true } : {}),
					})) {
						if (state.cancelRequested) {
							break;
						}
						if (isStreamDeltaEvent(event)) {
							deltaCoalescer?.push(event);
							continue;
						}
						// Pending deltas always precede any other event of the run.
						deltaCoalescer?.flush();
						if (event.type === "final") {
							finalResponse = event.content;
							await queueSessionSave("final");
						}
						if (event.type === "compaction_complete") {
							logCompactionSnapshot(log, runId, runtimeAgent, event.compacted);
							if (event.compacted) await queueSessionSave("compaction");
						}
						if (isTrackedRunEvent(event.type)) {
							logRunDebug(
								log,
								runId,
								`event.received ${summarizeRunEvent(event)}`,
							);
						}
						const seq = sendAgentEvent(state, runId, event);
						if (seq !== null && event.type === "steer_applied") {
							const confirmedIndex = polledUnconfirmedSteers.findIndex(
								(steer) => steer.steer_id === event.steer_id,
							);
							if (confirmedIndex >= 0) {
								polledUnconfirmedSteers.splice(confirmedIndex, 1);
								releaseSteerAttachments(event.steer_id);
							}
						}
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
						emitContextUsage(event.type);
						const contextLeftPercent = runtimeAgent.getContextLeftPercent();
						if (
							contextLeftPercent !== null &&
							state.updateContextLeftPercent(contextLeftPercent)
						) {
							sendRunContext(state, runId, contextLeftPercent);
							appendSession({
								type: "run.context",
								run_id: runId,
								ts: nowIso(),
								context_left_percent: contextLeftPercent,
							});
						}
						maybeDebouncedSessionSave();
					}
					state.closeRunSteers(runId);
					deltaCoalescer?.dispose();
					if (state.cancelRequested) {
						normalizeRuntimeAgentHistory(`run.cancel ${runId}`, runtimeAgent);
					}
					await queueSessionSave("terminal");
					emitRunSummaryDiagnostics();
					const status = state.cancelRequested ? "cancelled" : "completed";
					const terminalExtras = buildTerminalStatusExtras();
					emitRunStatus(runId, status, undefined, undefined, terminalExtras);
					emitRunEnd(
						runId,
						status === "completed" ? "completed" : "cancelled",
						finalResponse,
					);
				} catch (error) {
					state.closeRunSteers(runId);
					deltaCoalescer?.dispose();
					const err = error instanceof Error ? error : new Error(String(error));
					if (state.cancelRequested || isAbortLikeError(err)) {
						normalizeRuntimeAgentHistory(`run.cancel ${runId}`, runtimeAgent);
						await queueSessionSave("cancelled");
						emitRunSummaryDiagnostics();
						const terminalExtras = buildTerminalStatusExtras();
						emitRunStatus(
							runId,
							"cancelled",
							err.message || "cancelled",
							undefined,
							terminalExtras,
						);
						emitRunEnd(runId, "cancelled", finalResponse);
						return;
					}
					const safeFailure = normalizeRunFailure(err);
					logRunDebug(log, runId, `stream.error ${safeFailure.debugMessage}`);
					await queueSessionSave("error");
					emitRunSummaryDiagnostics();
					const terminalExtras = buildTerminalStatusExtras();
					emitRunStatus(
						runId,
						"error",
						safeFailure.statusMessage,
						safeFailure.statusError,
						terminalExtras,
					);
					appendSession({
						type: "run.error",
						run_id: runId,
						ts: nowIso(),
						error: safeFailure.error,
					});
					emitRunEnd(runId, "error");
				} finally {
					logRunDebug(log, runId, "stream.finally");
					buildTerminalStatusExtras();
					deltaCoalescer?.dispose();
					if (state.cancelRequested) {
						normalizeRuntimeAgentHistory(`run.cancel ${runId}`, runtimeAgent);
					}
					await queueSessionSave("finally");
					if (activeRunAbort?.runId === runId) {
						activeRunAbort = null;
					}
					state.finishRun(runId);
				}
			})();
		};
		// Admission shares the state lock with idle-only management writes.
		const admit = () => state.withAdmissionLock(run);
		const queued = runStartQueue.then(admit, admit).catch((error: unknown) => {
			if (admittedRunId) {
				const runId = admittedRunId;
				if (activeRunAbort?.runId === runId) activeRunAbort = null;
				state.finishRun(runId);
				if (responseSent) {
					try {
						sendRunStatus(state, runId, "error", "runtime start failed");
					} catch {
						// The transport may already be unavailable.
					}
				}
			}
			throw error;
		});
		runStartQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		return queued;
	};

	const handleRunSteer = (
		id: string,
		params: RunSteerParams,
	): Promise<void> => {
		const runId =
			typeof params?.run_id === "string" ? params.run_id.trim() : "";
		if (!runId) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "run_id is required",
			});
			return Promise.resolve();
		}
		let initialInput: UnresolvedRunInput;
		try {
			initialInput = normalizeRunInput(params.input, "run.steer");
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: String(error),
			});
			return Promise.resolve();
		}
		if (isRunInputEmpty(initialInput)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "run.steer input must not be empty",
			});
			return Promise.resolve();
		}
		const clientSteerId =
			typeof params.client_steer_id === "string" &&
			params.client_steer_id.trim()
				? params.client_steer_id.trim()
				: undefined;

		const admitSteer = async (): Promise<void> => {
			if (!state.canSteerRun(runId)) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUN_NOT_FOUND,
					message: "active run not found",
				});
				return;
			}
			const run = activeRunAbort?.runId === runId ? activeRunAbort : null;
			const sessionId = state.sessionId;
			const attachmentIds = runAttachmentIds(initialInput);
			let normalizedInput: NormalizedRunInput;
			try {
				if (attachmentIds.length > 0 && (!run || !sessionId))
					throw new AttachmentAdmissionError(
						"File attachments require an active conversation",
					);
				normalizedInput = await resolveRunInputAttachments(initialInput, {
					service: state.attachments,
					sessionId: sessionId ?? "",
					canReadAttachment: state.canReadAttachment,
					canUseVision: () => run?.agent.canUseVisualAttachments() === true,
					canPersistInlineImages: !!state.prepareRunImages,
					toolChoice: run?.toolChoice,
				});
				if (state.prepareRunImages)
					normalizedInput = await state.prepareRunImages(normalizedInput);
			} catch (error) {
				sendError(id, {
					code:
						error instanceof AttachmentAdmissionError
							? RPC_ERROR_CODE.INVALID_PARAMS
							: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
			let releaseAttachments: (() => void) | undefined;
			if (attachmentIds.length > 0 && sessionId && state.canSteerRun(runId)) {
				try {
					releaseAttachments = await state.attachments?.pin(
						attachmentIds,
						sessionId,
					);
				} catch {
					sendError(id, {
						code: RPC_ERROR_CODE.INVALID_PARAMS,
						message:
							"Could not retain the attachments for this conversation. Upload them again.",
					});
					return;
				}
			}
			if (!state.canSteerRun(runId)) {
				releaseAttachments?.();
				sendError(id, {
					code: RPC_ERROR_CODE.RUN_NOT_FOUND,
					message: "active run ended before steer could be queued",
				});
				return;
			}
			const steerId = state.enqueueRunSteer(
				runId,
				normalizedInput,
				clientSteerId,
			);
			if (releaseAttachments)
				steerAttachments.set(steerId, {
					ids: attachmentIds,
					release: releaseAttachments,
				});
			sendResult(id, {
				ok: true,
				steer_id: steerId,
			} satisfies RunSteerResult);
			logRunDebug(log, runId, `run.steer queued steer_id=${steerId}`);
		};

		const queued = runSteerQueue.then(admitSteer, admitSteer);
		runSteerQueue = queued.then(
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

	// Binds the runtime to an existing session without starting a run, so a
	// following session-scope `model.set` writes to it. Shares the run.start
	// queue so it never interleaves with run admission.
	const handleSessionOpen = (
		id: string,
		params: SessionOpenParams,
	): Promise<void> => {
		const open = async (): Promise<void> => {
			const sessionId = params?.session_id?.trim();
			if (!sessionId) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "session_id is required",
				});
				return;
			}
			if (state.activeRunId) {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_BUSY,
					message: "runtime busy",
				});
				return;
			}
			if (sessionId === state.sessionId) {
				sendResult(id, { session_id: sessionId } satisfies SessionOpenResult);
				return;
			}
			let opened: SessionState | null;
			try {
				opened = await sessionStateStore.load(sessionId);
			} catch (error) {
				sendError(id, {
					code: RPC_ERROR_CODE.SESSION_LOAD_FAILED,
					message: `session load failed: ${String(error)}`,
				});
				return;
			}
			if (!opened) {
				sendError(id, {
					code: RPC_ERROR_CODE.SESSION_NOT_FOUND,
					message: "session not found",
				});
				return;
			}
			if (opened.meta?.codelia_subagent) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "Delegated sessions cannot be opened as a root session",
				});
				return;
			}
			state.attachments?.discardDraft();
			state.sessionId = sessionId;
			state.sessionMeta = toMetaObject(opened.meta) ?? null;
			state.sessionAppend = null;
			applySessionModelOverrideFromMeta(state, opened.meta);
			// Drop any previous session's history and model; the next run.start
			// restores this session's history into a fresh Agent.
			state.agent = null;
			sendResult(id, { session_id: sessionId } satisfies SessionOpenResult);
			log(`session.open ${sessionId}`);
		};
		const queued = runStartQueue.then(open, open);
		runStartQueue = queued.then(
			() => undefined,
			() => undefined,
		);
		sessionOpenSettled = runStartQueue;
		return queued;
	};

	// Runs `task` once every session.open received so far has finished, so a
	// model.set sent right after session.open applies to the opened session.
	const afterSessionOpen = <T>(task: () => Promise<T>): Promise<T> =>
		sessionOpenSettled.then(task);

	return {
		handleRunStart,
		handleRunSteer,
		handleRunCancel,
		handleSessionOpen,
		afterSessionOpen,
	};
};
