import type { Tool } from "@codelia/core";
import { Agent, DEFAULT_MODEL_REGISTRY } from "@codelia/core";
import { type ApprovalMode, parseApprovalMode } from "@codelia/shared-types";
import { ToolOutputCacheStoreImpl } from "@codelia/storage";
import {
	AgentsResolver,
	appendInitialAgentsContext,
	createAgentsResolverKey,
} from "./agents";
import { shouldAutoOpenOAuthBrowser } from "./auth/oauth-utils";
import { openBrowser } from "./auth/openai-oauth";
import { resolveEffectiveModelConfig } from "./effective-model";
import {
	appendEnvironmentPermissionAllowRules,
	createEnvironmentAuthResolver,
	loadEnvironmentSystemPrompt,
	resolveEnvironmentExecutionEnvironmentConfig,
	resolveEnvironmentPermissionsConfig,
	resolveEnvironmentSearchConfig,
	resolveEnvironmentSkillsConfig,
} from "./environment-services";
import {
	appendInitialExecutionEnvironment,
	buildExecutionEnvironmentContext,
	logInitialExecutionEnvironmentDebug,
} from "./execution-environment";
import { debugLog, log } from "./logger";
import type { McpManager, McpOAuthPromptConfig, McpOAuthTokens } from "./mcp";
import { createMcpOAuthSession } from "./mcp/oauth";
import { createRuntimeModel } from "./model-factory";
import { buildModelRegistry } from "./model-registry";
import { resolveApprovalModeForRuntime } from "./permissions/approval-mode";
import {
	buildSystemPermissions,
	PermissionService,
} from "./permissions/service";
import { createToolPermissionHook } from "./permissions/hook";
import {
	sendAgentEventAsync,
	sendRunStatus,
	sendRunStatusAsync,
} from "./rpc/transport";
import {
	requestUiConfirm,
	requestUiPick,
	requestUiPrompt,
} from "./rpc/ui-requests";
import type { RuntimeState } from "./runtime-state";
import { createSandboxKey, SandboxContext } from "./sandbox/context";
import {
	appendInitialSkillsCatalog,
	createSkillsResolverKey,
	SkillsResolver,
} from "./skills";
import type { TaskManager } from "./tasks";
import { composeRuntimeTools, loadRuntimeHostTools } from "./tool-composition";
import { createTools } from "./tools";
import { createToolSessionContextKey } from "./tools/session-context";

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const waitForUiConfirmSupport = async (
	state: RuntimeState,
	timeoutMs = 5_000,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (state.uiCapabilities?.supports_confirm) {
			return true;
		}
		await sleep(50);
	}
	return !!state.uiCapabilities?.supports_confirm;
};

const APPROVAL_MODE_STARTUP_PICK_TITLE =
	"Choose approval mode for this project";
const APPROVAL_MODE_STARTUP_PICK_ITEMS: Array<{
	id: ApprovalMode;
	label: string;
	detail: string;
}> = [
	{
		id: "minimal",
		label: "minimal",
		detail: "Recommended default. Non-allowed operations require confirmation.",
	},
	{
		id: "trusted",
		label: "trusted",
		detail:
			"Adds workspace write-oriented allowlist. Other operations still require confirmation.",
	},
	{
		id: "full-access",
		label: "full-access",
		detail: "Skips confirmation for non-denied operations.",
	},
];

const requestApprovalModeStartupSelection = async (
	state: RuntimeState,
	projectKey: string,
): Promise<ApprovalMode | null> => {
	if (!state.uiCapabilities?.supports_pick) {
		return null;
	}
	const selection = await requestUiPick(state, {
		title: APPROVAL_MODE_STARTUP_PICK_TITLE,
		items: APPROVAL_MODE_STARTUP_PICK_ITEMS,
		multi: false,
	});
	const picked = parseApprovalMode(selection?.ids?.[0]);
	if (!picked) {
		log(`approval_mode startup selection skipped project=${projectKey}`);
		return null;
	}
	return picked;
};

export const requestMcpOAuthTokens = async (
	state: RuntimeState,
	serverId: string,
	oauth: McpOAuthPromptConfig,
	errorMessage: string,
): Promise<McpOAuthTokens | null> => {
	const canConfirm = state.uiCapabilities?.supports_confirm
		? true
		: await waitForUiConfirmSupport(state);
	if (!canConfirm) {
		return null;
	}
	const runId = state.activeRunId ?? undefined;
	if (!oauth.authorization_url || !oauth.token_url) {
		log(
			`mcp oauth skipped (${serverId}): missing authorization/token endpoint`,
		);
		return null;
	}

	let nextOAuth = { ...oauth };
	if (
		!nextOAuth.client_id &&
		!nextOAuth.registration_url &&
		state.uiCapabilities?.supports_prompt
	) {
		const prompt = await requestUiPrompt(state, {
			run_id: runId,
			title: `MCP OAuth (${serverId})`,
			message:
				"OAuth client_id is required. Enter client_id (empty value cancels).",
			multiline: false,
		});
		const clientId = prompt?.value?.trim();
		if (!clientId) {
			return null;
		}
		nextOAuth = {
			...nextOAuth,
			client_id: clientId,
		};
	}
	const authorizationUrl = nextOAuth.authorization_url;
	const tokenUrl = nextOAuth.token_url;
	if (!authorizationUrl || !tokenUrl) {
		return null;
	}

	const shouldAutoOpen = shouldAutoOpenOAuthBrowser();
	const canPasteCallback =
		!shouldAutoOpen && !!state.uiCapabilities?.supports_prompt;
	const session = await createMcpOAuthSession(
		{
			server_id: serverId,
			authorization_url: authorizationUrl,
			token_url: tokenUrl,
			registration_url: nextOAuth.registration_url,
			resource: nextOAuth.resource,
			scope: nextOAuth.scope,
			code_challenge_methods_supported:
				nextOAuth.code_challenge_methods_supported,
			client_id: nextOAuth.client_id,
			client_secret: nextOAuth.client_secret,
		},
		{
			callbackMode: canPasteCallback ? "paste" : "server",
		},
	);
	const lines = [
		`MCP server '${serverId}' requires OAuth.`,
		`Error: ${errorMessage}`,
		nextOAuth.authorization_url
			? `Authorization endpoint: ${nextOAuth.authorization_url}`
			: undefined,
		nextOAuth.token_url ? `Token endpoint: ${nextOAuth.token_url}` : undefined,
		session.redirectUri ? `Redirect URI: ${session.redirectUri}` : undefined,
		nextOAuth.resource ? `Resource: ${nextOAuth.resource}` : undefined,
		"",
		shouldAutoOpen
			? "Open browser and continue?"
			: canPasteCallback
				? "Open this URL manually. After the browser is redirected to localhost, paste the full URL in the next step."
				: "Open this URL manually, then continue.",
		"",
		session.authUrl,
	].filter((entry): entry is string => !!entry);
	const confirm = await requestUiConfirm(state, {
		run_id: runId,
		title: `MCP OAuth (${serverId})`,
		message: lines.join("\n"),
		confirm_label: shouldAutoOpen ? "Open browser" : "I opened it",
		cancel_label: "Cancel",
		allow_remember: false,
		allow_reason: false,
	});
	if (!confirm?.ok) {
		session.stop();
		return null;
	}
	if (shouldAutoOpen) {
		openBrowser(session.authUrl);
	}
	try {
		if (canPasteCallback) {
			const prompt = await requestUiPrompt(state, {
				run_id: runId,
				title: `MCP OAuth callback (${serverId})`,
				message:
					"After sign in completes, paste the full redirected URL from the browser address bar. You can also paste just code=...&state=....",
				multiline: false,
				secret: true,
			});
			const value = prompt?.value?.trim();
			if (!value) {
				return null;
			}
			return await session.completeFromInput(value);
		}
		return await session.waitForTokens();
	} finally {
		session.stop();
	}
};

export const requestMcpOAuthTokensWithRunStatus = async (
	state: RuntimeState,
	serverId: string,
	oauth: McpOAuthPromptConfig,
	errorMessage: string,
): Promise<McpOAuthTokens | null> => {
	const runId = state.activeRunId ?? undefined;
	if (runId) {
		sendRunStatus(
			state,
			runId,
			"awaiting_ui",
			`MCP auth required: ${serverId}`,
		);
	}
	try {
		const tokens = await requestMcpOAuthTokens(
			state,
			serverId,
			oauth,
			errorMessage,
		);
		if (!tokens) {
			log(`mcp oauth cancelled: ${serverId}`);
		}
		return tokens;
	} finally {
		if (runId) {
			sendRunStatus(state, runId, "running");
		}
	}
};

export const createAgentFactory = (
	state: RuntimeState,
	options: {
		mcpManager?: McpManager;
		taskManager?: TaskManager;
	} = {},
): (() => Promise<Agent>) => {
	let inFlight: Promise<Agent> | null = null;

	return async () => {
		if (state.agent) return state.agent;
		if (inFlight) return inFlight;

		inFlight = (async () => {
			const environment = state.effectiveEnvironment;
			const workspaceRoot =
				environment.workspace.root ??
				state.runtimeSandboxRoot ??
				state.runtimeWorkingDir ??
				undefined;
			const localRuntimeEnabled =
				environment.workspace.filesystem === "enabled" ||
				environment.workspace.process === "runtime" ||
				environment.tools.builtin === "full-coding-agent";
			let approvalModeResolution: {
				approvalMode: ApprovalMode;
				source: string;
				projectKey: string;
				persistSelection?: () => Promise<void>;
			} = {
				approvalMode: "minimal",
				source: "environment",
				projectKey: workspaceRoot ?? "disabled-workspace",
			};
			let ctx: SandboxContext | null = null;
			let sandboxKey: ReturnType<typeof createSandboxKey> | null = null;
			let agentsResolver: AgentsResolver | null = null;
			let skillsResolver: SkillsResolver | null = null;

			if (localRuntimeEnabled) {
				const sandboxRoot = workspaceRoot ?? process.cwd();
				approvalModeResolution = await resolveApprovalModeForRuntime({
					workingDir: sandboxRoot,
					runtimeSandboxRoot: sandboxRoot,
					requestStartupSelection: async ({ projectKey }) => {
						return requestApprovalModeStartupSelection(state, projectKey);
					},
					deferStartupSelectionPersist: true,
				});
				ctx = await SandboxContext.create(sandboxRoot, {
					approvalMode: approvalModeResolution.approvalMode,
				});
				log(
					`sandbox created at ${ctx.rootDir} approval_mode=${approvalModeResolution.approvalMode}`,
				);
				state.runtimeWorkingDir = ctx.workingDir;
				state.runtimeSandboxRoot = ctx.rootDir;
				sandboxKey = createSandboxKey(ctx);
			}

			if (
				environment.context.projectInstructions === "from-workspace" &&
				workspaceRoot
			) {
				agentsResolver =
					state.agentsResolver ?? (await AgentsResolver.create(workspaceRoot));
				state.agentsResolver = agentsResolver;
			}

			if (environment.context.skills === "from-config" && workspaceRoot) {
				let skillsConfig: Awaited<
					ReturnType<typeof resolveEnvironmentSkillsConfig>
				>;
				try {
					skillsConfig = await resolveEnvironmentSkillsConfig(
						state,
						workspaceRoot,
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					throw new Error(message);
				}
				skillsResolver =
					state.skillsResolver ??
					(await SkillsResolver.create({
						workingDir: workspaceRoot,
						config: skillsConfig,
					}));
				state.skillsResolver = skillsResolver;
				state.updateSkillsSnapshot(workspaceRoot, skillsResolver.getSnapshot());
			}

			state.approvalMode = approvalModeResolution.approvalMode;
			const toolOutputCacheStore =
				environment.adapters.stores?.toolOutputCacheStore ??
				(environment.persistence.mode === "runtime"
					? new ToolOutputCacheStoreImpl()
					: null);
			const todoSessionContextKey = createToolSessionContextKey(
				() => state.sessionId,
			);
			let baseLocalTools: Tool[] = [];
			if (environment.tools.builtin === "full-coding-agent") {
				if (!ctx || !sandboxKey || !agentsResolver || !skillsResolver) {
					throw new Error(
						"full coding-agent tools require local sandbox, AGENTS, and skills context",
					);
				}
				const agentsResolverKey = createAgentsResolverKey(agentsResolver);
				const skillsResolverKey = createSkillsResolverKey(skillsResolver);
				baseLocalTools = createTools(
					sandboxKey,
					agentsResolverKey,
					skillsResolverKey,
					{
						toolOutputCacheStore,
						todoSessionContextKey,
						taskManager: options.taskManager,
					},
				);
			}
			let mcpTools: Awaited<ReturnType<McpManager["getTools"]>> = [];
			if (environment.tools.mcp === "from-config" && options.mcpManager) {
				try {
					mcpTools = await options.mcpManager.getTools({
						onStatus: (message) => {
							log(`mcp: ${message}`);
						},
						requestOAuthTokens: async ({ server_id, oauth, error }) => {
							return requestMcpOAuthTokensWithRunStatus(
								state,
								server_id,
								oauth,
								error,
							);
						},
					});
				} catch (error) {
					log(`failed to load mcp tools: ${String(error)}`);
				}
			}
			const hostTools =
				environment.tools.host === "enabled"
					? await loadRuntimeHostTools(environment.adapters.toolProviders ?? [])
					: [];
			const baseSystemPrompt = await loadEnvironmentSystemPrompt(
				state,
				workspaceRoot,
			);
			let executionEnvironmentContext: string | null = null;
			if (
				environment.context.executionEnvironment === "from-config" &&
				workspaceRoot &&
				ctx
			) {
				const executionEnvironmentConfig =
					await resolveEnvironmentExecutionEnvironmentConfig(
						state,
						workspaceRoot,
					);
				executionEnvironmentContext = await buildExecutionEnvironmentContext({
					workingDir: workspaceRoot,
					sandboxRoot: ctx.rootDir,
					config: executionEnvironmentConfig,
				});
			}
			state.executionEnvironmentContext = executionEnvironmentContext;
			if (
				logInitialExecutionEnvironmentDebug(executionEnvironmentContext, {
					alreadyLogged: state.executionEnvironmentDebugLogged,
				})
			) {
				state.executionEnvironmentDebugLogged = true;
			}
			const withExecutionEnvironment = appendInitialExecutionEnvironment(
				baseSystemPrompt,
				executionEnvironmentContext,
			);
			const withAgentsContext = appendInitialAgentsContext(
				withExecutionEnvironment,
				agentsResolver?.buildInitialContext() ?? null,
			);
			const systemPrompt = appendInitialSkillsCatalog(
				withAgentsContext,
				skillsResolver ? await skillsResolver.buildInitialContext() : null,
			);
			state.systemPrompt = systemPrompt;
			let permissionsConfig: Awaited<
				ReturnType<typeof resolveEnvironmentPermissionsConfig>
			>;
			try {
				permissionsConfig =
					environment.config.source === "disabled" || !workspaceRoot
						? undefined
						: await resolveEnvironmentPermissionsConfig(state, workspaceRoot);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
			const permissionService = new PermissionService({
				approvalMode: approvalModeResolution.approvalMode,
				system: buildSystemPermissions(approvalModeResolution.approvalMode),
				user: permissionsConfig,
				...(ctx
					? {
							bashPathGuard: {
								rootDir: ctx.rootDir,
								workingDir: ctx.workingDir,
							},
						}
					: {}),
			});
			log(
				`approval_mode resolved=${approvalModeResolution.approvalMode} source=${approvalModeResolution.source} project=${approvalModeResolution.projectKey}`,
			);
			let modelConfig: Awaited<ReturnType<typeof resolveEffectiveModelConfig>>;
			try {
				modelConfig = await resolveEffectiveModelConfig(state, workspaceRoot);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
			const authResolver = await createEnvironmentAuthResolver(state, log);
			const provider = await authResolver.resolveProvider(modelConfig.provider);
			const providerAuth = await authResolver.resolveProviderAuth(provider);
			const searchConfig =
				environment.tools.search === "from-config"
					? await resolveEnvironmentSearchConfig(state, workspaceRoot)
					: undefined;
			const {
				tools,
				toolDefinitions,
				hostedTools,
				hostToolNames,
				editTool,
				applyPatchTool,
			} = await composeRuntimeTools({
				provider,
				baseTools: baseLocalTools,
				mcpTools,
				hostTools,
				...(searchConfig ? { searchConfig } : {}),
			});
			state.tools = tools;
			state.toolDefinitions = toolDefinitions;
			const getOpenAiAccessToken =
				authResolver.getOpenAiAccessToken?.bind(authResolver);
			const { llm, resolvedModelName } = await createRuntimeModel({
				provider,
				config: modelConfig,
				auth: providerAuth,
				useMetadata: environment.persistence.mode === "runtime",
				log,
				...(getOpenAiAccessToken ? { getOpenAiAccessToken } : {}),
			});
			state.currentModelProvider = provider;
			state.currentModelName = resolvedModelName;
			state.currentModelSource = modelConfig.source;
			const modelRegistry =
				environment.persistence.mode === "runtime"
					? await buildModelRegistry(llm, {
							strict: provider !== "openrouter",
						})
					: DEFAULT_MODEL_REGISTRY;
			const totalBudgetTrimEnabled = envTruthy(
				process.env.CODELIA_TOOL_OUTPUT_TOTAL_TRIM,
			);
			const canExecuteTool = createToolPermissionHook({
				permissionService,
				hostToolNames,
				isAutoApprovedTool: (tool) =>
					state.autoApprovedClientToolNames.has(tool),
				supportsConfirm: () => !!state.uiCapabilities?.supports_confirm,
				getActiveRunId: () => state.activeRunId ?? undefined,
				requestConfirm: (params) => requestUiConfirm(state, params),
				emitAgentEvent: async (runId, event) => {
					await sendAgentEventAsync(state, runId, event);
				},
				sendAwaitingUiStatus: (runId) =>
					sendRunStatusAsync(
						state,
						runId,
						"awaiting_ui",
						"waiting for confirmation",
					),
				sendRunningStatus: (runId) => {
					sendRunStatus(state, runId, "running");
				},
				persistAllowRules: (rules) =>
					appendEnvironmentPermissionAllowRules(state, workspaceRoot, rules),
				debug: debugLog,
				log,
				sandboxKey,
				...(editTool ? { editTool } : {}),
				...(applyPatchTool ? { applyPatchTool } : {}),
			});
			const agent = new Agent({
				llm,
				tools,
				hostedTools,
				systemPrompt,
				modelRegistry: modelRegistry ?? DEFAULT_MODEL_REGISTRY,
				toolOutputCache: {
					totalBudgetTrim: totalBudgetTrimEnabled,
				},
				services: { toolOutputCacheStore },
				canExecuteTool,
			});

			if (approvalModeResolution.persistSelection) {
				await approvalModeResolution.persistSelection();
			}
			state.agent = agent;
			return agent;
		})();

		try {
			return await inFlight;
		} finally {
			inFlight = null;
		}
	};
};
