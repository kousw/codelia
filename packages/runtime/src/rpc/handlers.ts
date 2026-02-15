import { updateModelConfig } from "@codelia/config-loader";
import type {
	Agent,
	RunEventStoreFactory,
	SessionRecord,
	SessionStateStore,
} from "@codelia/core";
import type {
	AuthLogoutParams,
	AuthLogoutResult,
	ContextInspectParams,
	InitializeParams,
	InitializeResult,
	McpListParams,
	ModelListDetails,
	ModelListParams,
	ModelSetParams,
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunCancelParams,
	RunStartParams,
	SessionHistoryParams,
	SessionListParams,
	SkillsListParams,
	UiContextUpdateParams,
} from "@codelia/protocol";
import {
	RunEventStoreFactoryImpl,
	SessionStateStoreImpl,
} from "@codelia/storage";
import {
	AuthResolver,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from "../auth/resolver";
import { type AuthFile, AuthStore } from "../auth/store";
import { resolveConfigPath } from "../config";
import { PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION } from "../constants";
import type { McpManager } from "../mcp";
import type { RuntimeState } from "../runtime-state";
import { createContextHandlers } from "./context";
import { createHistoryHandlers } from "./history";
import {
	buildProviderModelList as buildProviderModelListDefault,
	createModelHandlers,
} from "./model";
import { createRunHandlers } from "./run";
import { createSkillsHandlers } from "./skills";
import { sendError, sendResult } from "./transport";
import { requestUiConfirm, requestUiPick } from "./ui-requests";

export type RuntimeHandlerDeps = {
	state: RuntimeState;
	getAgent: () => Promise<Agent>;
	log: (message: string) => void;
	mcpManager?: McpManager;
	sessionStateStore?: SessionStateStore;
	runEventStoreFactory?: RunEventStoreFactory;
	buildProviderModelList?: typeof buildProviderModelListDefault;
};

export const createRuntimeHandlers = ({
	state,
	getAgent,
	log,
	mcpManager: injectedMcpManager,
	sessionStateStore: injectedSessionStateStore,
	runEventStoreFactory: injectedRunEventStoreFactory,
	buildProviderModelList: injectedBuildProviderModelList,
}: RuntimeHandlerDeps) => {
	const sessionStateStore =
		injectedSessionStateStore ??
		new SessionStateStoreImpl({
			onError: (error, context) => {
				log(
					`session-state ${context.action} error${context.detail ? ` (${context.detail})` : ""}: ${String(error)}`,
				);
			},
		});
	const runEventStoreFactory =
		injectedRunEventStoreFactory ?? new RunEventStoreFactoryImpl();
	const mcpManager = injectedMcpManager ?? {
		start: async () => undefined,
		list: () => ({ servers: [] }),
	};
	const buildProviderModelList =
		injectedBuildProviderModelList ?? buildProviderModelListDefault;
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
		const supportsPick = !!state.uiCapabilities?.supports_pick;
		const supportsPrompt = !!state.uiCapabilities?.supports_prompt;
		if (!supportsPick || !supportsPrompt) {
			return;
		}

		const authResolver = await AuthResolver.create(state, log);
		if (authResolver.hasAnyAvailableAuth()) {
			return;
		}

		const providerPick = await requestUiPick(state, {
			title: "Let's set up your provider to get started.",
			items: SUPPORTED_PROVIDERS.map((provider) => ({
				id: provider,
				label: provider,
				detail:
					provider === "openai"
						? "OAuth (ChatGPT Plus/Pro) or API key"
						: provider === "openrouter"
							? "API key (OpenRouter)"
							: "API key",
			})),
			multi: false,
		});
		const pickedProvider = providerPick?.ids?.[0];
		if (
			!pickedProvider ||
			!SUPPORTED_PROVIDERS.includes(pickedProvider as SupportedProvider)
		) {
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
		const configPath = resolveConfigPath();
		await updateModelConfig(configPath, { provider, name: selectedModel });
		state.agent = null;
		log(`startup onboarding completed: ${provider}/${selectedModel}`);
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

	const { handleRunStart, handleRunCancel } = createRunHandlers({
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
	});
	const { handleModelList, handleModelSet } = createModelHandlers({
		state,
		log,
	});
	const { handleContextInspect } = createContextHandlers({
		state,
		log,
	});
	const { handleSkillsList } = createSkillsHandlers({
		state,
		log,
	});

	const handleInitialize = (id: string, params: InitializeParams): void => {
		const result: InitializeResult = {
			protocol_version: PROTOCOL_VERSION,
			server: { name: SERVER_NAME, version: SERVER_VERSION },
			server_capabilities: {
				supports_run_cancel: true,
				supports_ui_requests: true,
				supports_mcp_list: true,
				supports_skills_list: true,
				supports_context_inspect: true,
				supports_permission_preflight_events: true,
			},
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

	const handleAuthLogout = async (
		id: string,
		params: AuthLogoutParams | undefined,
	): Promise<void> => {
		if (state.activeRunId) {
			sendError(id, { code: -32001, message: "runtime busy" });
			return;
		}

		const clearSession = params?.clear_session ?? true;
		try {
			const supportsConfirm = !!state.uiCapabilities?.supports_confirm;
			if (!supportsConfirm) {
				sendError(id, {
					code: -32000,
					message: "UI confirmation is required for logout",
				});
				return;
			}
			const confirm = await requestUiConfirm(state, {
				title: "Confirm logout",
				message:
					"This clears local auth credentials and resets the current session. Continue?",
				confirm_label: "Yes",
				cancel_label: "No",
				danger_level: "danger",
				allow_remember: false,
				allow_reason: false,
			});
			if (!confirm?.ok) {
				const result: AuthLogoutResult = {
					ok: false,
					auth_cleared: false,
					session_cleared: false,
					cancelled: true,
				};
				sendResult(id, result);
				log("auth.logout cancelled");
				return;
			}

			const store = new AuthStore();
			const cleared: AuthFile = { version: 1, providers: {} };
			await store.save(cleared);
			state.agent = null;
			if (clearSession) {
				state.sessionId = null;
				state.sessionAppend = null;
			}
			const result: AuthLogoutResult = {
				ok: true,
				auth_cleared: true,
				session_cleared: clearSession,
			};
			sendResult(id, result);
			log(`auth.logout session_cleared=${clearSession}`);
		} catch (error) {
			sendError(id, {
				code: -32000,
				message: `auth logout failed: ${String(error)}`,
			});
		}
	};

	const handleRequest = async (req: RpcRequest): Promise<void> => {
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
			case "auth.logout":
				return handleAuthLogout(req.id, req.params as AuthLogoutParams);
			case "model.list":
				return handleModelList(req.id, req.params as ModelListParams);
			case "model.set":
				return handleModelSet(req.id, req.params as ModelSetParams);
			case "mcp.list":
				await mcpManager.start?.();
				return sendResult(
					req.id,
					mcpManager.list((req.params as McpListParams | undefined)?.scope),
				);
			case "skills.list":
				return handleSkillsList(req.id, req.params as SkillsListParams);
			case "context.inspect":
				return handleContextInspect(req.id, req.params as ContextInspectParams);
			default:
				return sendError(req.id, { code: -32601, message: "method not found" });
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

	const processMessage = (msg: RpcMessage): void => {
		if ("method" in msg) {
			if ("id" in msg && msg.id !== undefined) {
				void handleRequest(msg as RpcRequest);
				return;
			}
			handleNotification(msg as RpcNotification);
			return;
		}
		handleResponse(msg as RpcResponse);
	};

	return { processMessage };
};
