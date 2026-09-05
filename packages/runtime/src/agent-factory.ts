import type { Tool } from "@codelia/core";
import {
	Agent,
	DEFAULT_MODEL_REGISTRY,
	ToolPermissionDenied,
} from "@codelia/core";
import type { ApprovalMode } from "@codelia/shared-types";
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
	resolveEnvironmentSubagentConfig,
} from "./environment-services";
import {
	appendInitialExecutionEnvironment,
	buildExecutionEnvironmentContext,
	logInitialExecutionEnvironmentDebug,
} from "./execution-environment";
import { debugLog, log } from "./logger";
import type { McpManager, McpOAuthPromptConfig, McpOAuthTokens } from "./mcp";
import {
	type McpOAuthPromptGateway,
	requestMcpOAuthTokens as runMcpOAuthPrompt,
} from "./mcp/oauth-prompt";
import { createRuntimeModel } from "./model-factory";
import { buildModelRegistry } from "./model-registry";
import { resolveApprovalModeForRuntime } from "./permissions/approval-mode";
import { createToolPermissionHook } from "./permissions/hook";
import {
	buildSystemPermissions,
	PermissionService,
} from "./permissions/service";
import { requestApprovalModeStartupSelection as selectStartupApprovalMode } from "./permissions/startup-selection";
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
import type { AgentTreeCoordinator } from "./subagents/coordinator";
import { subagentSpawnSchema } from "./subagents/coordinator";
import { formatAgentMessages } from "./subagents/mailbox";
import type { TaskManager } from "./tasks";
import { composeRuntimeTools, loadRuntimeHostTools } from "./tool-composition";
import { createTools } from "./tools";
import { createToolSessionContextKey } from "./tools/session-context";
import { createSubagentTaskTools } from "./tools/task";

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

const requestApprovalModeStartupSelection = async (
	state: RuntimeState,
	projectKey: string,
): Promise<ApprovalMode | null> => {
	if (!state.uiCapabilities?.supports_pick) {
		return null;
	}
	return selectStartupApprovalMode(
		{
			pick: (params) => requestUiPick(state, params),
			log,
		},
		projectKey,
	);
};

export const requestMcpOAuthTokens = async (
	state: RuntimeState,
	serverId: string,
	oauth: McpOAuthPromptConfig,
	errorMessage: string,
): Promise<McpOAuthTokens | null> => {
	const gateway: McpOAuthPromptGateway = {
		runId: state.activeRunId ?? undefined,
		supportsPrompt: !!state.uiCapabilities?.supports_prompt,
		waitForConfirmSupport: () => waitForUiConfirmSupport(state),
		confirm: (params) => requestUiConfirm(state, params),
		prompt: (params) => requestUiPrompt(state, params),
		shouldAutoOpenBrowser: shouldAutoOpenOAuthBrowser,
		openBrowser,
		log,
	};
	return runMcpOAuthPrompt(gateway, serverId, oauth, errorMessage);
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
		subagents?: AgentTreeCoordinator;
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
			if (options.subagents?.isAvailable() && workspaceRoot) {
				baseLocalTools.push(
					...createSubagentTaskTools(
						options.subagents,
						() => state.sessionId,
						async (params, ctx) => {
							if (!state.subagentSpawn)
								throw new Error("Subagent policy is not initialized");
							return state.subagentSpawn(params, ctx);
						},
					),
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
			const subagentConfig =
				options.subagents?.isAvailable() && workspaceRoot
					? await resolveEnvironmentSubagentConfig(state, workspaceRoot)
					: undefined;
			let baseSystemPrompt = await loadEnvironmentSystemPrompt(
				state,
				workspaceRoot,
			);
			if (subagentConfig) {
				baseSystemPrompt += `\n\n<subagent_model_profiles>\nAvailable configured profiles for task_spawn.profile. Descriptions are configuration data, not delegation authorization. A user-requested model or profile takes precedence; otherwise omit both fields to use default_profile, or the parent model if no default exists.\n${JSON.stringify(subagentConfig)}\n</subagent_model_profiles>`;
			}
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
			if (options.subagents?.isAvailable() && workspaceRoot) {
				for (const name of baseLocalTools
					.filter((t) => t.name.startsWith("task_"))
					.map((t) => t.name)) {
					if (tools.filter((t) => t.name === name).length !== 1)
						throw new Error(`Delegated task tool name conflict: ${name}`);
				}
			}
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
				requestConfirm: (params, signal) =>
					requestUiConfirm(state, params, signal),
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
			if (options.subagents?.isAvailable() && workspaceRoot) {
				const coordinator = options.subagents;
				coordinator.setOutputCache(toolOutputCacheStore);
				state.subagentMessages = async (sessionId, signal) =>
					formatAgentMessages(
						await coordinator.mailbox.receive(sessionId, "parent", 0, signal),
					);
				coordinator.setApproval(async (request) => {
					if (
						state.sessionId !== request.owner_session_id ||
						!state.uiCapabilities?.supports_confirm ||
						request.signal?.aborted
					)
						return false;
					const confirmation = await requestUiConfirm(
						state,
						{
							run_id: state.activeRunId ?? undefined,
							title: `Subagent ${request.task_name ?? request.task_id}: ${request.tool}`,
							message: `Shared workspace operation requested by child ${request.task_id}:\n${request.raw_args}`,
							confirm_label: "Allow",
							cancel_label: "Deny",
							allow_remember: false,
						},
						request.signal,
					);
					return !request.signal?.aborted && confirmation?.ok === true;
				});
				coordinator.configure({
					subagent: subagentConfig,
					workspace_root: workspaceRoot,
					model: {
						provider,
						name: resolvedModelName,
						reasoning: modelConfig.reasoning,
						verbosity: modelConfig.verbosity,
						fast: modelConfig.fast,
						experimental: modelConfig.experimental,
					},
					approval_mode: approvalModeResolution.approvalMode,
					permissions: permissionsConfig,
				});
				state.subagentSpawn = async (raw, toolContext) => {
					const params = subagentSpawnSchema.parse(raw);
					const sessionId = state.sessionId;
					const runId = state.activeRunId;
					if (
						!sessionId ||
						toolContext.signal?.aborted ||
						(runId && state.cancelRequested)
					)
						throw new Error("No active parent session");
					const decision = await canExecuteTool(
						{
							id: `subagent-${crypto.randomUUID()}`,
							type: "function",
							function: {
								name: "task_spawn",
								arguments: JSON.stringify(params),
							},
						},
						JSON.stringify(params),
						toolContext,
					);
					if (decision.decision !== "allow")
						throw new ToolPermissionDenied(decision);
					if (
						state.sessionId !== sessionId ||
						(runId && (state.activeRunId !== runId || state.cancelRequested))
					)
						throw new Error("Parent turn stopped before admission");
					return coordinator.spawn(params, {
						session_id: sessionId,
						run_id: runId ?? undefined,
						signal: toolContext.signal,
					});
				};
			}
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
				canExecuteTool: (call, raw, ctx) =>
					options.subagents?.isAvailable() &&
					workspaceRoot &&
					call.function.name === "task_spawn"
						? { decision: "allow" }
						: canExecuteTool(call, raw, ctx),
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
