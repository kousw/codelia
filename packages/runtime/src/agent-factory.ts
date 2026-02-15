import { promises as fs } from "node:fs";
import type { BaseChatModel } from "@codelia/core";
import {
	Agent,
	ChatAnthropic,
	ChatOpenAI,
	DEFAULT_MODEL_REGISTRY,
} from "@codelia/core";
import { ToolOutputCacheStoreImpl } from "@codelia/storage";
import {
	AgentsResolver,
	appendInitialAgentsContext,
	createAgentsResolverKey,
} from "./agents";
import { OPENAI_OAUTH_BASE_URL, openBrowser } from "./auth/openai-oauth";
import { AuthResolver } from "./auth/resolver";
import type { ProviderAuth } from "./auth/store";
import {
	appendPermissionAllowRules,
	loadSystemPrompt,
	readEnvValue,
	resolveModelConfig,
	resolvePermissionsConfig,
	resolveReasoningEffort,
	resolveSkillsConfig,
	resolveTextVerbosity,
} from "./config";
import { debugLog, log } from "./logger";
import type { McpManager, McpOAuthPromptConfig, McpOAuthTokens } from "./mcp";
import { createMcpOAuthSession } from "./mcp/oauth";
import { buildModelRegistry } from "./model-registry";
import {
	buildSystemPermissions,
	PermissionService,
} from "./permissions/service";
import {
	sendAgentEventAsync,
	sendRunStatus,
	sendRunStatusAsync,
} from "./rpc/transport";
import { requestUiConfirm, requestUiPrompt } from "./rpc/ui-requests";
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
import { createTools } from "./tools";
import { createUnifiedDiff } from "./utils/diff";

const requireApiKeyAuth = (provider: string, auth: ProviderAuth): string => {
	if (auth.method !== "api_key") {
		throw new Error(`${provider} requires an API key`);
	}
	return auth.api_key;
};

const envTruthy = (value?: string): boolean => {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "1" || normalized === "true";
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const buildOpenAiClientOptions = (
	authResolver: AuthResolver,
	auth: ProviderAuth,
): Record<string, unknown> => {
	if (auth.method === "api_key") {
		return { apiKey: auth.api_key };
	}
	let accountId = auth.oauth.account_id;
	const enableDebugHttp = envTruthy(process.env.CODELIA_DEBUG);
	const apiKey = async () => {
		const result = await authResolver.getOpenAiAccessToken();
		accountId = result.accountId ?? accountId;
		return result.token;
	};
	const fetchWithAccount = Object.assign(
		async (
			input: URL | RequestInfo,
			init?: RequestInit | BunFetchRequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers ?? {});
			if (accountId) {
				headers.set("ChatGPT-Account-Id", accountId);
			}
			const nextInit = init ? { ...init, headers } : { headers };
			const response = await fetch(input, nextInit);
			if (enableDebugHttp && !response.ok) {
				const url =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
				const requestId =
					response.headers.get("x-request-id") ??
					response.headers.get("cf-ray") ??
					"-";
				let body = "";
				try {
					body = await response.clone().text();
				} catch {
					body = "";
				}
				const snippet = body ? body.slice(0, 1000) : "(empty)";
				log(
					`openai http error status=${response.status} request_id=${requestId} url=${url} body=${snippet}`,
				);
			}
			return response;
		},
		{ preconnect: fetch.preconnect },
	) as typeof fetch;
	return {
		apiKey,
		baseURL: OPENAI_OAUTH_BASE_URL,
		fetch: fetchWithAccount,
	};
};

const buildOpenRouterClientOptions = (
	auth: ProviderAuth,
): Record<string, unknown> => {
	const headers: Record<string, string> = {};
	const referer = readEnvValue("OPENROUTER_HTTP_REFERER");
	if (referer) {
		headers["HTTP-Referer"] = referer;
	}
	const title = readEnvValue("OPENROUTER_X_TITLE");
	if (title) {
		headers["X-Title"] = title;
	}
	return {
		apiKey: requireApiKeyAuth("OpenRouter", auth),
		baseURL: OPENROUTER_BASE_URL,
		...(Object.keys(headers).length ? { defaultHeaders: headers } : {}),
	};
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

	const session = await createMcpOAuthSession({
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
	});
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
		"Open browser and continue?",
		"",
		session.authUrl,
	].filter((entry): entry is string => !!entry);
	const confirm = await requestUiConfirm(state, {
		run_id: runId,
		title: `MCP OAuth (${serverId})`,
		message: lines.join("\n"),
		confirm_label: "Open browser",
		cancel_label: "Cancel",
		allow_remember: false,
		allow_reason: false,
	});
	if (!confirm?.ok) {
		session.stop();
		return null;
	}
	openBrowser(session.authUrl);
	try {
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
		sendRunStatus(runId, "awaiting_ui", `MCP auth required: ${serverId}`);
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
			sendRunStatus(runId, "running");
		}
	}
};

export const createAgentFactory = (
	state: RuntimeState,
	options: {
		mcpManager?: McpManager;
	} = {},
): (() => Promise<Agent>) => {
	let inFlight: Promise<Agent> | null = null;

	return async () => {
		if (state.agent) return state.agent;
		if (inFlight) return inFlight;

		inFlight = (async () => {
			const rootDir = process.env.CODELIA_SANDBOX_ROOT;
			const ctx = await SandboxContext.create(rootDir);
			log(`sandbox created at ${ctx.rootDir}`);
			const agentsResolver =
				state.agentsResolver ?? (await AgentsResolver.create(ctx.workingDir));
			state.agentsResolver = agentsResolver;
			let skillsConfig: Awaited<ReturnType<typeof resolveSkillsConfig>>;
			try {
				skillsConfig = await resolveSkillsConfig(ctx.workingDir);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
			const skillsResolver =
				state.skillsResolver ??
				(await SkillsResolver.create({
					workingDir: ctx.workingDir,
					config: skillsConfig,
				}));
			state.skillsResolver = skillsResolver;
			state.updateSkillsSnapshot(ctx.workingDir, skillsResolver.getSnapshot());
			state.runtimeWorkingDir = ctx.workingDir;
			state.runtimeSandboxRoot = ctx.rootDir;
			const sandboxKey = createSandboxKey(ctx);
			const agentsResolverKey = createAgentsResolverKey(agentsResolver);
			const skillsResolverKey = createSkillsResolverKey(skillsResolver);
			const toolOutputCacheStore = new ToolOutputCacheStoreImpl();
			const localTools = createTools(
				sandboxKey,
				agentsResolverKey,
				skillsResolverKey,
				{
					toolOutputCacheStore,
				},
			);
			const editTool = localTools.find(
				(tool) => tool.definition.name === "edit",
			);
			let mcpTools: Awaited<ReturnType<McpManager["getTools"]>> = [];
			if (options.mcpManager) {
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
			const tools = [...localTools, ...mcpTools];
			state.toolDefinitions = tools.map((tool) => tool.definition);
			const baseSystemPrompt = await loadSystemPrompt(ctx.workingDir);
			const withAgentsContext = appendInitialAgentsContext(
				baseSystemPrompt,
				agentsResolver.buildInitialContext(),
			);
			const systemPrompt = appendInitialSkillsCatalog(
				withAgentsContext,
				await skillsResolver.buildInitialContext(),
			);
			state.systemPrompt = systemPrompt;
			let permissionsConfig: Awaited<
				ReturnType<typeof resolvePermissionsConfig>
			>;
			try {
				permissionsConfig = await resolvePermissionsConfig(ctx.workingDir);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
			const permissionService = new PermissionService({
				system: buildSystemPermissions(),
				user: permissionsConfig,
				bashPathGuard: {
					rootDir: ctx.rootDir,
					workingDir: ctx.workingDir,
				},
			});
			let modelConfig: Awaited<ReturnType<typeof resolveModelConfig>>;
			try {
				modelConfig = await resolveModelConfig(ctx.workingDir);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message);
			}
			const authResolver = await AuthResolver.create(state, log);
			const provider = await authResolver.resolveProvider(modelConfig.provider);
			const providerAuth = await authResolver.resolveProviderAuth(provider);
			let llm: BaseChatModel;
			switch (provider) {
				case "openai": {
					const reasoningEffort = resolveReasoningEffort(modelConfig.reasoning);
					const textVerbosity = resolveTextVerbosity(modelConfig.verbosity);
					llm = new ChatOpenAI({
						clientOptions: buildOpenAiClientOptions(authResolver, providerAuth),
						...(modelConfig.name ? { model: modelConfig.name } : {}),
						...(reasoningEffort ? { reasoningEffort } : {}),
						...(textVerbosity ? { textVerbosity } : {}),
					});
					break;
				}
				case "openrouter": {
					const reasoningEffort = resolveReasoningEffort(modelConfig.reasoning);
					const textVerbosity = resolveTextVerbosity(modelConfig.verbosity);
					llm = new ChatOpenAI({
						clientOptions: buildOpenRouterClientOptions(providerAuth),
						...(modelConfig.name ? { model: modelConfig.name } : {}),
						...(reasoningEffort ? { reasoningEffort } : {}),
						...(textVerbosity ? { textVerbosity } : {}),
					});
					break;
				}
				case "anthropic": {
					llm = new ChatAnthropic({
						clientOptions: {
							apiKey: requireApiKeyAuth("Anthropic", providerAuth),
						},
						...(modelConfig.name ? { model: modelConfig.name } : {}),
					});
					break;
				}
				default:
					throw new Error(`Unsupported model.provider: ${provider}`);
			}
			const modelRegistry = await buildModelRegistry(llm, {
				strict: provider !== "openrouter",
			});
			const agent = new Agent({
				llm,
				tools,
				systemPrompt,
				modelRegistry: modelRegistry ?? DEFAULT_MODEL_REGISTRY,
				services: { toolOutputCacheStore },
				canExecuteTool: async (call, rawArgs, toolCtx) => {
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
					if (call.function.name === "write") {
						const parsed = parseToolArgsObject(rawArgs);
						const filePath =
							typeof parsed?.file_path === "string" ? parsed.file_path : "";
						const content =
							typeof parsed?.content === "string" ? parsed.content : "";
						if (filePath) {
							try {
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
							await sendAgentEventAsync(state, runId, {
								type: "permission.preview",
								tool: call.function.name,
								...(previewDiff ? { diff: previewDiff } : {}),
								...(previewSummary ? { summary: previewSummary } : {}),
								...(previewTruncated ? { truncated: true } : {}),
							});
						}
						await sendAgentEventAsync(state, runId, {
							type: "permission.ready",
							tool: call.function.name,
						});
						await sendRunStatusAsync(
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
						sendRunStatus(runId, "running");
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
							void appendPermissionAllowRules(ctx.workingDir, rules).catch(
								(error) => {
									log(`failed to persist permission: ${String(error)}`);
								},
							);
						}
					}
					return { decision: "allow" };
				},
			});

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
