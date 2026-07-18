import { promises as fs } from "node:fs";
import type { BaseChatModel, Tool, ToolDefinition } from "@codelia/core";
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
import type { ResolvedSearchConfig } from "./config";
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
import {
	createSandboxKey,
	getSandboxContext,
	SandboxContext,
} from "./sandbox/context";
import {
	appendInitialSkillsCatalog,
	createSkillsResolverKey,
	SkillsResolver,
} from "./skills";
import type { TaskManager } from "./tasks";
import { createTools } from "./tools";
import { createSearchTool } from "./tools/search";
import { createToolSessionContextKey } from "./tools/session-context";
import { createUnifiedDiff } from "./utils/diff";
import { resolvePreviewLanguageHint } from "./utils/language";

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const isNativeSearchProvider = (
	provider: string,
	allowedProviders: string[],
): boolean => allowedProviders.includes(provider);

const buildHostedSearchToolDefinitions = (
	provider: BaseChatModel["provider"],
	options: ResolvedSearchConfig,
): ToolDefinition[] => {
	if (
		options.mode === "local" ||
		!isNativeSearchProvider(provider, options.native.providers)
	) {
		return [];
	}
	if (provider !== "openai" && provider !== "anthropic") {
		return [];
	}
	return [
		{
			type: "hosted_search",
			name: "web_search",
			provider,
			...(options.native.searchContextSize
				? { search_context_size: options.native.searchContextSize }
				: {}),
			...(options.native.allowedDomains
				? { allowed_domains: options.native.allowedDomains }
				: {}),
			...(options.native.userLocation
				? { user_location: options.native.userLocation }
				: {}),
		},
	];
};

const loadHostTools = async (
	providers: NonNullable<
		RuntimeState["effectiveEnvironment"]["adapters"]["toolProviders"]
	>,
): Promise<Tool[]> => {
	const groups = await Promise.all(
		providers.map((provider) => Promise.resolve(provider.getTools())),
	);
	return groups.flat();
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

const MAX_CONFIRM_PREVIEW_LINES = 120;

const splitLines = (value: string): string[] =>
	value.split("\n").map((line) => line.replace(/\r$/, ""));

type BoundedDiffPreview = {
	diff: string | null;
	truncated: boolean;
};

const buildBoundedDiffPreview = (
	diff: string,
	maxLines = MAX_CONFIRM_PREVIEW_LINES,
): BoundedDiffPreview => {
	if (!diff.trim()) return { diff: null, truncated: false };
	const lines = splitLines(diff);
	if (!lines.length) return { diff: null, truncated: false };
	if (lines.length <= maxLines) {
		return { diff: lines.join("\n"), truncated: false };
	}
	return {
		diff: lines.slice(0, maxLines).join("\n"),
		truncated: true,
	};
};

const parseToolArgsObject = (
	rawArgs: string,
): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(rawArgs) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
};

const unwrapToolJsonObject = (
	result: unknown,
): Record<string, unknown> | null => {
	if (!result || typeof result !== "object") return null;
	const typed = result as Record<string, unknown>;
	if (typed.type !== "json") return null;
	const value = typed.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
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
			const editTool = baseLocalTools.find(
				(tool) => tool.definition.name === "edit",
			);
			const applyPatchTool = baseLocalTools.find(
				(tool) => tool.definition.name === "apply_patch",
			);
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
					? await loadHostTools(environment.adapters.toolProviders ?? [])
					: [];
			const hostToolNames = new Set(hostTools.map((tool) => tool.name));
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
			let hostedSearchDefinitions: ToolDefinition[] = [];
			let localSearchTools: Tool[] = [];
			if (environment.tools.search === "from-config") {
				const searchConfig = await resolveEnvironmentSearchConfig(
					state,
					workspaceRoot,
				);
				hostedSearchDefinitions = buildHostedSearchToolDefinitions(
					provider,
					searchConfig,
				);
				if (
					searchConfig.mode === "native" &&
					hostedSearchDefinitions.length === 0
				) {
					throw new Error(
						`search.mode=native is enabled, but native search is unavailable for provider '${provider}'.`,
					);
				}
				const useLocalSearchTool =
					searchConfig.mode === "local" ||
					(searchConfig.mode === "auto" &&
						hostedSearchDefinitions.length === 0);
				localSearchTools = useLocalSearchTool
					? [
							createSearchTool({
								defaultBackend: searchConfig.local.backend,
								braveApiKeyEnv: searchConfig.local.braveApiKeyEnv,
							}),
						]
					: [];
			}
			const tools = [
				...baseLocalTools,
				...localSearchTools,
				...mcpTools,
				...hostTools,
			];
			state.tools = tools;
			state.toolDefinitions = [
				...tools.map((tool) => tool.definition),
				...hostedSearchDefinitions,
			];
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
			const agent = new Agent({
				llm,
				tools,
				hostedTools: hostedSearchDefinitions,
				systemPrompt,
				modelRegistry: modelRegistry ?? DEFAULT_MODEL_REGISTRY,
				toolOutputCache: {
					totalBudgetTrim: totalBudgetTrimEnabled,
				},
				services: { toolOutputCacheStore },
				canExecuteTool: async (call, rawArgs, toolCtx) => {
					if (hostToolNames.has(call.function.name)) {
						debugLog(
							`permission.evaluate tool=${call.function.name} decision=allow reason=host-tool`,
						);
						return { decision: "allow" };
					}
					if (state.autoApprovedClientToolNames.has(call.function.name)) {
						debugLog(
							`permission.evaluate tool=${call.function.name} decision=allow reason=client-tool-auto-approved`,
						);
						return { decision: "allow" };
					}
					const decision = permissionService.evaluate(
						call.function.name,
						rawArgs,
					);
					debugLog(
						`permission.evaluate tool=${call.function.name} decision=${decision.decision}${decision.reason ? ` reason=${decision.reason}` : ""}`,
					);
					if (decision.decision === "allow") {
						return { decision: "allow" };
					}
					if (decision.decision === "deny") {
						return { decision: "deny", reason: decision.reason };
					}

					const supportsConfirm = !!state.uiCapabilities?.supports_confirm;
					if (!supportsConfirm) {
						return {
							decision: "deny",
							reason: "UI confirm not supported",
						};
					}
					const runId = state.activeRunId ?? undefined;
					debugLog(
						`permission.request tool=${call.function.name} args=${rawArgs}`,
					);
					const prompt = permissionService.getConfirmPrompt(
						call.function.name,
						rawArgs,
					);
					let previewDiff: string | null = null;
					let previewSummary: string | null = null;
					let previewTruncated = false;
					let previewFilePath: string | null = null;
					let previewLanguage: string | null = null;
					if (call.function.name === "write") {
						const parsed = parseToolArgsObject(rawArgs);
						const filePath =
							typeof parsed?.file_path === "string" ? parsed.file_path : "";
						const content =
							typeof parsed?.content === "string" ? parsed.content : "";
						const language =
							typeof parsed?.language === "string" ? parsed.language : "";
						if (filePath) {
							previewFilePath = filePath;
							previewLanguage =
								resolvePreviewLanguageHint({
									language,
									filePath,
									content,
								}) ?? previewLanguage;
							try {
								if (!sandboxKey) {
									throw new Error("sandbox is unavailable");
								}
								const sandbox = await getSandboxContext(toolCtx, sandboxKey);
								const resolved = sandbox.resolvePath(filePath);
								let before = "";
								try {
									const stat = await fs.stat(resolved);
									if (!stat.isDirectory()) {
										before = await fs.readFile(resolved, "utf8");
									}
								} catch {
									before = "";
								}
								const preview = buildBoundedDiffPreview(
									createUnifiedDiff(filePath, before, content),
								);
								previewDiff = preview.diff;
								previewTruncated = preview.truncated;
							} catch {
								previewDiff = null;
								previewSummary = null;
								previewTruncated = false;
							}
						}
					} else if (call.function.name === "edit" && editTool) {
						const parsed = parseToolArgsObject(rawArgs);
						if (parsed) {
							const filePath =
								typeof parsed.file_path === "string" ? parsed.file_path : "";
							const language =
								typeof parsed.language === "string" ? parsed.language : "";
							if (filePath) {
								previewFilePath = filePath;
							}
							previewLanguage =
								resolvePreviewLanguageHint({
									language,
									filePath,
								}) ?? previewLanguage;
							const dryRunInput = { ...parsed, dry_run: true };
							try {
								const result = await editTool.executeRaw(
									JSON.stringify(dryRunInput),
									toolCtx,
								);
								if (result && typeof result === "object") {
									const obj = unwrapToolJsonObject(result);
									if (!obj) {
										previewSummary =
											"Preview unavailable: unexpected dry-run output";
									} else {
										const resultFilePath =
											typeof obj.file_path === "string" ? obj.file_path : "";
										const resultLanguage =
											typeof obj.language === "string" ? obj.language : "";
										if (!previewFilePath && resultFilePath) {
											previewFilePath = resultFilePath;
										}
										const diff = typeof obj.diff === "string" ? obj.diff : "";
										const summary =
											typeof obj.summary === "string" ? obj.summary : "";
										previewLanguage =
											resolvePreviewLanguageHint({
												language: resultLanguage || previewLanguage,
												filePath: previewFilePath || resultFilePath,
												diff,
											}) ?? previewLanguage;
										const preview = buildBoundedDiffPreview(diff);
										previewDiff = preview.diff;
										previewTruncated = preview.truncated;
										if (!previewDiff) {
											previewSummary = summary || "Preview: no diff content";
										}
									}
								}
							} catch {
								previewSummary = "Preview unavailable: dry-run failed";
							}
						}
					} else if (call.function.name === "apply_patch" && applyPatchTool) {
						const parsed = parseToolArgsObject(rawArgs);
						if (parsed) {
							const dryRunInput = { ...parsed, dry_run: true };
							try {
								const result = await applyPatchTool.executeRaw(
									JSON.stringify(dryRunInput),
									toolCtx,
								);
								if (result && typeof result === "object") {
									const obj = unwrapToolJsonObject(result);
									if (!obj) {
										previewSummary =
											"Preview unavailable: unexpected dry-run output";
									} else {
										const diff = typeof obj.diff === "string" ? obj.diff : "";
										const summary =
											typeof obj.summary === "string" ? obj.summary : "";
										const preview = buildBoundedDiffPreview(diff);
										previewDiff = preview.diff;
										previewTruncated = preview.truncated;
										if (!previewDiff) {
											previewSummary = summary || "Preview: no diff content";
										}
									}
								}
							} catch {
								previewSummary = "Preview unavailable: dry-run failed";
							}
						}
					}
					if (runId) {
						if (previewDiff || previewSummary) {
							previewLanguage =
								resolvePreviewLanguageHint({
									language: previewLanguage,
									filePath: previewFilePath,
									diff: previewDiff,
								}) ?? previewLanguage;
							await sendAgentEventAsync(state, runId, {
								type: "permission.preview",
								tool: call.function.name,
								tool_call_id: call.id,
								...(previewFilePath ? { file_path: previewFilePath } : {}),
								...(previewLanguage ? { language: previewLanguage } : {}),
								...(previewDiff ? { diff: previewDiff } : {}),
								...(previewSummary ? { summary: previewSummary } : {}),
								...(previewTruncated ? { truncated: true } : {}),
							});
						}
						await sendAgentEventAsync(state, runId, {
							type: "permission.ready",
							tool: call.function.name,
							tool_call_id: call.id,
						});
						await sendRunStatusAsync(
							state,
							runId,
							"awaiting_ui",
							"waiting for confirmation",
						);
					}
					const confirmResult = await requestUiConfirm(state, {
						run_id: runId,
						title: prompt.title,
						message: prompt.message,
						confirm_label: "Allow",
						cancel_label: "Deny",
						allow_remember: true,
						allow_reason: true,
					});
					if (runId) {
						sendRunStatus(state, runId, "running");
					}
					if (!confirmResult?.ok) {
						const providedReason = confirmResult?.reason?.trim() ?? "";
						const reason = providedReason || "permission denied";
						const stopTurn = providedReason.length === 0;
						debugLog(
							`permission.confirm denied tool=${call.function.name} stop_turn=${String(stopTurn)}${reason ? ` reason=${reason}` : ""}`,
						);
						return { decision: "deny", reason, stop_turn: stopTurn };
					}
					if (confirmResult?.remember) {
						const rules = permissionService.rememberAllow(
							call.function.name,
							rawArgs,
						);
						debugLog(
							`permission.remember tool=${call.function.name} rules=${rules.length}`,
						);
						if (rules.length) {
							void appendEnvironmentPermissionAllowRules(
								state,
								workspaceRoot,
								rules,
							).catch((error) => {
								log(`failed to persist permission: ${String(error)}`);
							});
						}
					}
					return { decision: "allow" };
				},
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
