import type {
	Agent,
	AgentEvent,
	RunEventStoreFactory,
	SessionRecord,
	SessionStateStore,
	ToolOutputCacheStore,
} from "@codelia/core";
import {
	type AuthLoginCancelParams,
	type AuthLoginCompleteParams,
	type AuthLoginParams,
	type AuthLogoutParams,
	type AuthStatusParams,
	type ConfigGetParams,
	type ConfigSetParams,
	type ContextInspectParams,
	type InitializeParams,
	type InitializeResult,
	type McpListParams,
	type ModelListDetails,
	type ModelListParams,
	type ModelSetParams,
	type PermissionsListParams,
	type PermissionsRemoveParams,
	RPC_ERROR_CODE,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
	type RunCancelParams,
	type RunStartParams,
	type SessionHistoryParams,
	type SessionListParams,
	type SessionOpenParams,
	type SessionUpdateParams,
	type ShellCancelParams,
	type ShellDetachParams,
	type ShellExecParams,
	type ShellListParams,
	type ShellOutputParams,
	type ShellStartParams,
	type ShellStatusParams,
	type ShellWaitParams,
	type SkillsListParams,
	type TaskCancelParams,
	type TaskListParams,
	type TaskResultParams,
	type TaskSpawnParams,
	type TaskStatusParams,
	type TaskWaitParams,
	type ThemeSetParams,
	type ThemeSetResult,
	type ToolCallParams,
	type UiContextUpdateParams,
} from "@codelia/protocol";
import {
	RunEventStoreFactoryImpl,
	SessionStateStoreImpl,
} from "@codelia/storage";
import {
	configuredProviders,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from "../auth/resolver";
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "../constants";
import { isTuiLocalEnvironment } from "../environment";
import {
	createEnvironmentAuthResolver,
	resolveEnvironmentModelConfig,
	resolveEnvironmentTuiConfig,
	updateEnvironmentModel,
	updateEnvironmentTuiTheme,
} from "../environment-services";
import type { McpManager } from "../mcp";
import type { RuntimeState } from "../runtime-state";
import type { AgentTreeCoordinator } from "../subagents/coordinator";
import type { TaskManager } from "../tasks";
import {
	VolatileRunEventStoreFactory,
	VolatileSessionStateStore,
	VolatileToolOutputCacheStore,
} from "../volatile-stores";
import { createAuthLogoutHandler } from "./auth";
import {
	createAuthManagementHandlers,
	supportsAuthManagement,
} from "./auth-management";
import { createConfigHandlers, supportsConfigReadWrite } from "./config";
import { createContextHandlers } from "./context";
import { createContextUsageHandlers } from "./context-usage";
import { createHistoryHandlers } from "./history";
import { createSessionUpdateHandler } from "./session-lifecycle";
import { createImageHandlers } from "./image";
import {
	buildProviderModelList as buildProviderModelListDefault,
	createModelHandlers,
} from "./model";
import { createPermissionsHandlers } from "./permissions";
import {
	buildResumeDiff,
	hasStructuredResumeContextMeta,
} from "./resume-context";
import { createRunHandlers } from "./run";
import { createShellHandlers } from "./shell";
import { createSkillsHandlers } from "./skills";
import { createTaskHandlers } from "./task";
import { createToolHandlers } from "./tool";
import {
	hasRpcResponse,
	sendError,
	sendNotificationAsync,
	sendResult,
	withRpcResponseContext,
} from "./transport";
import { requestUiPick } from "./ui-requests";

const SUPPORTED_TUI_THEMES = new Set([
	"codelia",
	"ocean",
	"forest",
	"rose",
	"sakura",
	"mauve",
	"plum",
	"iris",
	"crimson",
	"wine",
]);

type ReadableToolOutputCacheStore = ToolOutputCacheStore &
	Required<Pick<ToolOutputCacheStore, "read" | "readLine">>;

const isReadableToolOutputCacheStore = (
	store: ToolOutputCacheStore | null | undefined,
): store is ReadableToolOutputCacheStore =>
	!!store &&
	typeof store.read === "function" &&
	typeof store.readLine === "function";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const validateRequestParams = (
	method: string,
	params: unknown,
): string | null => {
	if (params !== undefined && !isRecord(params))
		return "params must be an object";
	if (method === "initialize" && !isRecord(params))
		return "params are required";
	if (method === "run.cancel") {
		if (
			!isRecord(params) ||
			typeof params.run_id !== "string" ||
			!params.run_id.trim()
		) {
			return "run_id is required";
		}
		if (params.reason !== undefined && typeof params.reason !== "string") {
			return "reason must be a string";
		}
	}
	if (method === "run.start" && isRecord(params)) {
		if (
			params.session_id !== undefined &&
			typeof params.session_id !== "string"
		) {
			return "session_id must be a string";
		}
	}
	return null;
};

export type RuntimeHandlerDeps = {
	state: RuntimeState;
	getAgent: () => Promise<Agent>;
	log: (message: string) => void;
	mcpManager?: McpManager;
	sessionStateStore?: SessionStateStore;
	cleanupSessionLogs?: (sessionId: string) => Promise<void>;
	runEventStoreFactory?: RunEventStoreFactory;
	buildProviderModelList?: typeof buildProviderModelListDefault;
	taskManager?: TaskManager;
	subagents?: AgentTreeCoordinator;
};

export const createRuntimeHandlers = ({
	state,
	getAgent,
	log,
	mcpManager: injectedMcpManager,
	sessionStateStore: injectedSessionStateStore,
	cleanupSessionLogs,
	runEventStoreFactory: injectedRunEventStoreFactory,
	buildProviderModelList: injectedBuildProviderModelList,
	taskManager: injectedTaskManager,
	subagents,
}: RuntimeHandlerDeps) => {
	const environment = state.effectiveEnvironment;
	const imageHandlers = createImageHandlers(state);
	const sessionStateStore: SessionStateStore =
		injectedSessionStateStore ??
		environment.adapters.stores?.sessionStateStore ??
		(environment.persistence.mode === "volatile"
			? new VolatileSessionStateStore()
			: new SessionStateStoreImpl({
					onError: (error, context) => {
						log(
							`session-state ${context.action} error${context.detail ? ` (${context.detail})` : ""}: ${String(error)}`,
						);
					},
				}));
	const runEventStoreFactory =
		injectedRunEventStoreFactory ??
		environment.adapters.stores?.runEventStoreFactory ??
		(environment.persistence.mode === "volatile"
			? new VolatileRunEventStoreFactory()
			: new RunEventStoreFactoryImpl());
	const mcpManager = injectedMcpManager ?? {
		start: async () => undefined,
		list: () => ({ servers: [] }),
	};
	const buildProviderModelList =
		injectedBuildProviderModelList ?? buildProviderModelListDefault;
	const adapterToolOutputCacheStore =
		environment.adapters.stores?.toolOutputCacheStore;
	const toolOutputCacheStore = isReadableToolOutputCacheStore(
		adapterToolOutputCacheStore,
	)
		? adapterToolOutputCacheStore
		: environment.persistence.mode === "volatile"
			? new VolatileToolOutputCacheStore()
			: undefined;
	let startupOnboardingPromise: Promise<void> | null = null;
	let startupOnboardingStarted = false;

	const appendSession = (record: SessionRecord): void => {
		if (!state.sessionAppend) return;
		state.sessionAppend(record);
	};

	const formatUsdPer1M = (value: number | undefined): string | null => {
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			return null;
		}
		const fixed = value.toFixed(4);
		return fixed.replace(/\.?0+$/, "");
	};

	const buildModelPickDetail = (
		details: ModelListDetails | undefined,
	): string => {
		const parts: string[] = [];
		if (details?.release_date) {
			parts.push(`released ${details.release_date}`);
		}
		const inputCost = formatUsdPer1M(details?.cost_per_1m_input_tokens_usd);
		const outputCost = formatUsdPer1M(details?.cost_per_1m_output_tokens_usd);
		if (inputCost !== null || outputCost !== null) {
			parts.push(
				`cost in/out ${inputCost ?? "-"}/${outputCost ?? "-"} USD per 1M`,
			);
		}
		return parts.join(" • ");
	};

	const runStartupOnboarding = async (): Promise<void> => {
		if (!isTuiLocalEnvironment(state.effectiveEnvironment)) {
			return;
		}
		const supportsPick = !!state.uiCapabilities?.supports_pick;
		const supportsPrompt = !!state.uiCapabilities?.supports_prompt;
		if (!supportsPick || !supportsPrompt) {
			return;
		}
		// The client shows its own sign-in UI through auth.status/auth.login.
		if (state.uiCapabilities?.supports_auth_management) {
			return;
		}

		const authResolver = await createEnvironmentAuthResolver(state, log);
		if (authResolver.hasAnyAvailableAuth()) {
			return;
		}

		const onboardingConfig = await resolveEnvironmentModelConfig(
			state,
			state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined,
		);
		const providers = configuredProviders(onboardingConfig.providers);
		const providerPick = await requestUiPick(state, {
			title: "Let's set up your provider to get started.",
			items: providers.map((provider) => ({
				id: provider,
				label: provider,
				detail:
					provider === "openai"
						? "OAuth (ChatGPT Plus/Pro) or API key"
						: provider === "openrouter"
							? "API key (OpenRouter)"
							: provider === "moonshot"
								? "API key (Moonshot)"
								: provider === "zai"
									? "API key (Z.ai)"
									: provider === "xai"
										? "API key (xAI)"
										: "API key",
			})),
			multi: false,
		});
		const pickedProvider = providerPick?.ids?.[0];
		if (!pickedProvider || !providers.includes(pickedProvider)) {
			log("startup onboarding skipped (provider not selected)");
			return;
		}
		const provider = pickedProvider as SupportedProvider;

		try {
			await authResolver.resolveProviderAuth(provider);
		} catch (error) {
			log(`startup onboarding auth failed: ${String(error)}`);
			return;
		}

		const { models, details } = await buildProviderModelList({
			provider,
			includeDetails: true,
			state,
			log,
		});
		if (!models.length) {
			log(`startup onboarding model list returned no models for ${provider}`);
			return;
		}
		const modelPick = await requestUiPick(state, {
			title: `Select model (${provider})`,
			items: models.map((model) => ({
				id: model,
				label: model,
				detail: buildModelPickDetail(details?.[model]) || undefined,
			})),
			multi: false,
		});
		const selectedModel = modelPick?.ids?.[0];
		if (!selectedModel || !models.includes(selectedModel)) {
			log("startup onboarding skipped (model not selected)");
			return;
		}
		const workingDir =
			state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? process.cwd();
		const modelTarget = await updateEnvironmentModel(state, workingDir, {
			provider,
			name: selectedModel,
		});
		state.sessionModelOverride = null;
		state.currentModelProvider = provider;
		state.currentModelName = selectedModel;
		state.currentModelSource = "config";
		state.agent = null;
		log(
			`startup onboarding completed: ${provider}/${selectedModel} scope=${modelTarget.scope} path=${modelTarget.path}`,
		);
	};

	const launchStartupOnboarding = (): void => {
		if (startupOnboardingStarted) {
			return;
		}
		startupOnboardingStarted = true;
		startupOnboardingPromise = runStartupOnboarding()
			.catch((error) => {
				log(`startup onboarding failed: ${String(error)}`);
			})
			.finally(() => {
				startupOnboardingPromise = null;
			});
	};

	const waitForStartupOnboarding = async (): Promise<void> => {
		if (!startupOnboardingPromise) return;
		await startupOnboardingPromise;
	};

	const { handleRunStart, handleRunCancel, handleSessionOpen } =
		createRunHandlers({
			state,
			getAgent,
			log,
			runEventStoreFactory,
			sessionStateStore,
			appendSession,
			beforeRunStart: waitForStartupOnboarding,
		});
	const { handleSessionList, handleSessionHistory } = createHistoryHandlers({
		sessionStateStore,
		log,
		readRunLogs: environment.persistence.mode === "runtime",
		...(environment.events.live === "host"
			? {
					sendHistoryEvent: async (
						runId: string,
						seq: number,
						event: AgentEvent,
					): Promise<void> => {
						const notify: RpcNotification = {
							jsonrpc: "2.0",
							method: "agent.event",
							params: {
								run_id: runId,
								seq,
								event,
								meta: { replayed: true },
							},
						};
						await sendNotificationAsync(state, notify);
					},
				}
			: {}),
		getCurrentWorkspaceRoot: () =>
			state.lastUiContext?.workspace_root ??
			state.agentsResolver?.getRootDir() ??
			state.runtimeSandboxRoot ??
			state.runtimeWorkingDir ??
			environment.workspace.root,
		buildResumeDiffSummary: async (meta) => {
			if (!hasStructuredResumeContextMeta(meta)) {
				return undefined;
			}
			const diff = await buildResumeDiff(meta, state, {
				bestEffortCurrentContext: true,
			});
			if (!diff?.changed) {
				return undefined;
			}
			return diff.summary;
		},
	});
	const { handleModelList, handleModelSet } = createModelHandlers({
		state,
		log,
		sessionStateStore,
	});
	const { handleContextInspect } = createContextHandlers({
		state,
		log,
	});
	const { handleSkillsList } = createSkillsHandlers({
		state,
		log,
	});
	const { handleToolCall } = createToolHandlers({
		state,
		getAgent,
	});
	const processHandlersEnabled =
		state.effectiveEnvironment.workspace.process === "runtime";
	const shellHandlers = processHandlersEnabled
		? createShellHandlers({
				state,
				log,
				taskManager: injectedTaskManager,
				outputCache: toolOutputCacheStore ?? undefined,
			})
		: null;
	const taskHandlers = processHandlersEnabled
		? createTaskHandlers({
				state,
				getAgent,
				subagents,
				log,
				taskManager: injectedTaskManager,
				outputCache: toolOutputCacheStore ?? undefined,
			})
		: null;

	const handleInitialize = async (
		id: string,
		params: InitializeParams,
	): Promise<void> => {
		let resolvedTheme: string | undefined;
		const environment = state.effectiveEnvironment;
		if (isTuiLocalEnvironment(environment)) {
			try {
				const workingDir =
					state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? process.cwd();
				resolvedTheme = (await resolveEnvironmentTuiConfig(state, workingDir))
					.theme;
			} catch (error) {
				log(`initialize tui config load failed: ${String(error)}`);
			}
		}
		const processEnabled = environment.workspace.process === "runtime";
		const mcpEnabled = environment.tools.mcp === "from-config";
		const skillsEnabled = environment.context.skills === "from-config";
		const themeSetEnabled =
			isTuiLocalEnvironment(environment) &&
			environment.config.source !== "disabled";
		let modelProviders: string[] = [...SUPPORTED_PROVIDERS];
		try {
			const config = await resolveEnvironmentModelConfig(
				state,
				state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined,
			);
			modelProviders = configuredProviders(config.providers);
		} catch (error) {
			log(`initialize provider config load failed: ${String(error)}`);
		}
		const result: InitializeResult = {
			model_providers: modelProviders,
			protocol_version: PROTOCOL_VERSION,
			server: { name: SERVER_NAME, version: SERVER_VERSION },
			server_capabilities: {
				supports_model_ultrafast: true,
				supports_scoped_logout:
					environment.auth.model === "runtime-default" ||
					Boolean(environment.adapters.credentialProvider?.clearProviderAuth),
				supports_auth_management: supportsAuthManagement(state),
				supports_session_open: true,
				supports_run_cancel: true,
				supports_run_diagnostics: true,
				supports_session_lifecycle: !!sessionStateStore.updateMetadata,
				supports_shell_exec: processEnabled,
				supports_shell_tasks: processEnabled,
				supports_shell_detach: processEnabled,
				supports_tasks: processEnabled,
				supported_task_kinds: processEnabled
					? subagents?.isAvailable()
						? ["shell", "subagent"]
						: ["shell"]
					: [],
				...(subagents?.isAvailable() ? { max_subagent_depth: 1 } : {}),
				...(processEnabled && subagents?.isAvailable()
					? { supports_task_progress: true }
					: {}),
				supports_ui_requests: isTuiLocalEnvironment(environment),
				supports_mcp_list: mcpEnabled,
				supports_skills_list: skillsEnabled,
				supports_context_inspect: true,
				supports_config_rw: supportsConfigReadWrite(state),
				supports_permissions_rw: supportsConfigReadWrite(state),
				supports_context_usage: true,
				supports_tool_call: true,
				supports_theme_set: themeSetEnabled,
				supports_image_generation: isTuiLocalEnvironment(environment),
				supports_permission_preflight_events: true,
				supports_text_delta: true,
			},
			...(resolvedTheme ? { tui: { theme: resolvedTheme } } : {}),
		};
		sendResult(id, result);
		log(`initialize from ${params.client?.name ?? "unknown"}`);
		state.lastClientInfo = params.client ?? null;
		state.setUiCapabilities(params.ui_capabilities);
		launchStartupOnboarding();
	};

	const handleUiContextUpdate = (params: UiContextUpdateParams): void => {
		state.updateUiContext(params);
		log(
			`ui.context.update cwd=${params.cwd ?? "-"} file=${params.active_file?.path ?? "-"}`,
		);
	};

	const handleThemeSet = async (
		id: string,
		params: ThemeSetParams | undefined,
	): Promise<void> => {
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const name = params?.name?.trim().toLowerCase();
		if (!name) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "theme name is required",
			});
			return;
		}
		if (!SUPPORTED_TUI_THEMES.has(name)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported theme: ${name}`,
			});
			return;
		}
		const workingDir =
			state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? process.cwd();
		try {
			const target = await updateEnvironmentTuiTheme(state, workingDir, name);
			const result: ThemeSetResult = {
				name,
				scope: target.scope,
				path: target.path,
			};
			sendResult(id, result);
			log(`theme.set ${name} scope=${target.scope} path=${target.path}`);
		} catch (error) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: String(error),
			});
		}
	};

	const handleAuthLogout = createAuthLogoutHandler({ state, log });
	const handleSessionUpdate = createSessionUpdateHandler({
		sessions: sessionStateStore,
		state,
		log,
		cleanup: cleanupSessionLogs,
	});
	const authHandlers = createAuthManagementHandlers({ state, log });
	const configHandlers = createConfigHandlers({ state, log });
	const permissionsHandlers = createPermissionsHandlers({ state, log });
	const contextUsageHandlers = createContextUsageHandlers({ state, log });

	const handleRequest = async (req: RpcRequest): Promise<void> => {
		const mcpEnabled = state.effectiveEnvironment.tools.mcp === "from-config";
		const skillsEnabled =
			state.effectiveEnvironment.context.skills === "from-config";
		const themeSetEnabled =
			isTuiLocalEnvironment(state.effectiveEnvironment) &&
			state.effectiveEnvironment.config.source !== "disabled";
		const rejectDisabled = (message: string): void =>
			sendError(req.id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message,
			});
		switch (req.method) {
			case "initialize":
				return handleInitialize(req.id, req.params as InitializeParams);
			case "run.start":
				return handleRunStart(req.id, req.params as RunStartParams);
			case "run.cancel":
				return handleRunCancel(req.id, req.params as RunCancelParams);
			case "session.list":
				return handleSessionList(req.id, req.params as SessionListParams);
			case "session.history":
				return handleSessionHistory(req.id, req.params as SessionHistoryParams);
			case "session.open":
				return handleSessionOpen(req.id, req.params as SessionOpenParams);
			case "session.update":
				return handleSessionUpdate(req.id, req.params as SessionUpdateParams);
			case "auth.logout":
				return handleAuthLogout(req.id, req.params as AuthLogoutParams);
			case "auth.status":
				return authHandlers.handleStatus(
					req.id,
					req.params as AuthStatusParams,
				);
			case "auth.login":
				return authHandlers.handleLogin(req.id, req.params as AuthLoginParams);
			case "auth.login.complete":
				return authHandlers.handleLoginComplete(
					req.id,
					req.params as AuthLoginCompleteParams,
				);
			case "auth.login.cancel":
				return authHandlers.handleLoginCancel(
					req.id,
					req.params as AuthLoginCancelParams,
				);
			case "config.get":
				return configHandlers.handleConfigGet(
					req.id,
					req.params as ConfigGetParams,
				);
			case "config.set":
				return configHandlers.handleConfigSet(
					req.id,
					req.params as ConfigSetParams,
				);
			case "permissions.list":
				return permissionsHandlers.handlePermissionsList(
					req.id,
					req.params as PermissionsListParams,
				);
			case "permissions.remove":
				return permissionsHandlers.handlePermissionsRemove(
					req.id,
					req.params as PermissionsRemoveParams,
				);
			case "model.list":
				return handleModelList(req.id, req.params as ModelListParams);
			case "image.model.get":
				return imageHandlers.handle(req.id, "get", req.params);
			case "image.model.configure":
				return imageHandlers.handle(req.id, "configure", req.params);
			case "image.artifact.get":
				return imageHandlers.handle(req.id, "artifact", req.params);
			case "model.set":
				return handleModelSet(req.id, req.params as ModelSetParams);
			case "tool.call":
				return handleToolCall(req.id, req.params as ToolCallParams);
			case "shell.exec":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellExec(
					req.id,
					req.params as ShellExecParams,
				);
			case "shell.start":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellStart(
					req.id,
					req.params as ShellStartParams,
				);
			case "shell.list":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellList(
					req.id,
					req.params as ShellListParams,
				);
			case "shell.status":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellStatus(
					req.id,
					req.params as ShellStatusParams,
				);
			case "shell.output":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellOutput(
					req.id,
					req.params as ShellOutputParams,
				);
			case "shell.wait":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellWait(
					req.id,
					req.params as ShellWaitParams,
				);
			case "shell.detach":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellDetach(
					req.id,
					req.params as ShellDetachParams,
				);
			case "shell.cancel":
				if (!shellHandlers)
					return rejectDisabled("process execution is disabled");
				return shellHandlers.handleShellCancel(
					req.id,
					req.params as ShellCancelParams,
				);
			case "task.spawn":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskSpawn(
					req.id,
					req.params as TaskSpawnParams,
				);
			case "task.list":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskList(
					req.id,
					req.params as TaskListParams,
				);
			case "task.status":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskStatus(
					req.id,
					req.params as TaskStatusParams,
				);
			case "task.wait":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskWait(
					req.id,
					req.params as TaskWaitParams,
				);
			case "task.cancel":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskCancel(
					req.id,
					req.params as TaskCancelParams,
				);
			case "task.result":
				if (!taskHandlers)
					return rejectDisabled("process execution is disabled");
				return taskHandlers.handleTaskResult(
					req.id,
					req.params as TaskResultParams,
				);
			case "mcp.list":
				if (!mcpEnabled) {
					return sendResult(req.id, { servers: [] });
				}
				await mcpManager.start?.();
				return sendResult(
					req.id,
					mcpManager.list((req.params as McpListParams | undefined)?.scope),
				);
			case "skills.list":
				if (!skillsEnabled) return rejectDisabled("skills are disabled");
				return handleSkillsList(req.id, req.params as SkillsListParams);
			case "context.inspect":
				return handleContextInspect(req.id, req.params as ContextInspectParams);
			case "context.usage":
				return contextUsageHandlers.handleContextUsage(req.id);
			case "theme.set":
				if (!themeSetEnabled)
					return rejectDisabled("theme setting is disabled");
				return handleThemeSet(req.id, req.params as ThemeSetParams);
			default:
				return sendError(req.id, {
					code: RPC_ERROR_CODE.METHOD_NOT_FOUND,
					message: "method not found",
				});
		}
	};

	const handleNotification = (note: RpcNotification): void => {
		if (note.method === "ui.context.update") {
			handleUiContextUpdate(note.params as UiContextUpdateParams);
		}
	};

	const handleResponse = (res: RpcResponse): void => {
		if (state.resolveUiResponse(res)) return;
		log(`unhandled response: ${res.id}`);
	};

	const processMessage = (msg: unknown): void => {
		if (!isRecord(msg)) {
			log("invalid rpc message");
			return;
		}
		const id = typeof msg.id === "string" ? msg.id : undefined;
		if (
			msg.jsonrpc !== "2.0" ||
			("method" in msg && typeof msg.method !== "string")
		) {
			if (id !== undefined) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_REQUEST,
					message: "invalid request",
				});
			} else {
				log("invalid rpc message");
			}
			return;
		}
		if (typeof msg.method === "string") {
			if ("id" in msg && id === undefined) {
				log("invalid rpc request id");
				return;
			}
			const invalid = validateRequestParams(msg.method, msg.params);
			if (invalid) {
				if (id !== undefined)
					sendError(id, {
						code: RPC_ERROR_CODE.INVALID_PARAMS,
						message: invalid,
					});
				else log(`invalid rpc notification: ${msg.method}`);
				return;
			}
			if (id !== undefined) {
				void withRpcResponseContext(id, async () => {
					try {
						await handleRequest(msg as RpcRequest);
					} catch {
						if (!hasRpcResponse(id)) {
							try {
								sendError(id, {
									code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
									message: "internal runtime error",
								});
							} catch {
								// The transport itself is unavailable.
							}
						}
						try {
							log(`rpc handler failed: ${msg.method}`);
						} catch {
							/* logging is best effort */
						}
					}
				});
				return;
			}
			try {
				handleNotification(msg as RpcNotification);
			} catch {
				log(`rpc notification failed: ${msg.method}`);
			}
			return;
		}
		if (id !== undefined && ("result" in msg || "error" in msg)) {
			handleResponse(msg as RpcResponse);
		} else if (id !== undefined) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_REQUEST,
				message: "invalid request",
			});
		} else {
			log("invalid rpc message");
		}
	};

	return { processMessage };
};
