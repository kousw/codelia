import type { Tool } from "@codelia/core";
import {
	getInitializeProtocolVersion,
	getMcpCompatibleProtocolVersions,
	getMcpProtocolVersion,
	isSupportedMcpProtocolVersion,
	type McpListResult,
	type McpListScope,
	type McpListServer,
	type McpServerState,
} from "@codelia/protocol";
import { DEFAULT_OAUTH_REFRESH_TIMEOUT_MS } from "@codelia/storage";
import { type ResolvedMcpServerConfig, resolveMcpServers } from "../config";
import type { ShellChild } from "../permissions/shell-backend";
import {
	MCP_AUTH_VERSION,
	type McpAuthFile,
	McpAuthStore,
	type McpOAuthTokens,
	type McpServerAuthBinding,
} from "./auth-store";
import {
	HttpMcpClient,
	isMcpHttpAuthError,
	type McpClient,
	StdioMcpClient,
} from "./client";
import {
	type DiscoveredOAuthConfig,
	fetchDiscoveredOAuthConfig,
	mcpEntryMatchesServer,
	parseTokenResponse,
	resolveMcpServerBinding,
} from "./oauth-helpers";
import {
	createMcpToolAdapter,
	fetchAllMcpTools,
	hasToolCapability,
	type McpToolDescriptor,
} from "./tooling";

const OAUTH_TOKEN_EXPIRY_SKEW_MS = 60_000;

type McpServerRuntime = {
	config: ResolvedMcpServerConfig;
	state: McpServerState;
	last_error?: string;
	last_connected_at?: string;
	tools_count?: number;
	client?: McpClient;
	toolAdapters: Tool[];
};

export type McpOAuthPromptConfig = {
	issuer?: string;
	authorization_url?: string;
	token_url?: string;
	registration_url?: string;
	resource?: string;
	scope?: string;
	code_challenge_methods_supported?: string[];
	client_id?: string;
	client_secret?: string;
};
type ResolvedOAuthConfig = McpOAuthPromptConfig;

const awaitWithAbort = <T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> => {
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("MCP OAuth token refresh timed out"),
		);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("MCP OAuth token refresh timed out"),
			);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
};

const nowIso = (): string => new Date().toISOString();

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const toListServer = (
	id: string,
	runtime: McpServerRuntime,
): McpListServer => ({
	id,
	transport: runtime.config.transport,
	source: runtime.config.source,
	enabled: runtime.config.enabled,
	state: runtime.state,
	tools: runtime.tools_count,
	last_error: runtime.last_error,
	last_connected_at: runtime.last_connected_at,
});

type ManagerOptions = {
	workingDir: string;
	spawnStdio?: (
		config: ResolvedMcpServerConfig,
		signal: AbortSignal,
	) => Promise<ShellChild>;
	log: (message: string) => void;
	/** Optional override for OAuth refresh timeout (defaults to 30s). */
	refreshTimeoutMs?: number;
};

export type McpConnectOptions = {
	onStatus?: (message: string) => void;
	requestOAuthTokens?: (params: {
		server_id: string;
		error: string;
		oauth: McpOAuthPromptConfig;
		signal: AbortSignal;
	}) => Promise<McpOAuthTokens | null>;
};

const isAuthRequiredError = (error: unknown): boolean => {
	if (isMcpHttpAuthError(error)) return true;
	const message = describeError(error).toLowerCase();
	return message.includes("mcp http 401") || message.includes("unauthorized");
};

export class McpManager {
	private readonly servers = new Map<string, McpServerRuntime>();
	private readonly clients = new Set<McpClient>();
	private readonly authStore = new McpAuthStore();
	private startPromise: Promise<void> | null = null;
	private closePromise: Promise<void> | null = null;
	private closed = false;
	private readonly shutdownController = new AbortController();
	private authFile: McpAuthFile = { version: MCP_AUTH_VERSION, servers: {} };
	private readonly discoveredOAuth = new Map<string, DiscoveredOAuthConfig>();
	private startedWithOAuthFlow = false;
	private requestOAuthTokensCallback?: McpConnectOptions["requestOAuthTokens"];

	constructor(private readonly options: ManagerOptions) {}

	start(connectOptions?: McpConnectOptions): Promise<void> {
		if (this.closed) return Promise.reject(new Error("MCP manager is closed"));
		if (connectOptions?.requestOAuthTokens) {
			this.requestOAuthTokensCallback = connectOptions.requestOAuthTokens;
		}
		const wantsOAuthFlow = !!connectOptions?.requestOAuthTokens;
		if (!this.startPromise || (wantsOAuthFlow && !this.startedWithOAuthFlow)) {
			this.startPromise = this.initialize(connectOptions);
		}
		return this.startPromise;
	}

	async getTools(connectOptions?: McpConnectOptions): Promise<Tool[]> {
		await this.start(connectOptions);
		return Array.from(this.servers.values()).flatMap(
			(server) => server.toolAdapters,
		);
	}

	list(_scope: McpListScope = "loaded"): McpListResult {
		const servers = Array.from(this.servers.entries())
			.map(([id, runtime]) => toListServer(id, runtime))
			.sort((left, right) => left.id.localeCompare(right.id));
		return { servers };
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = Promise.resolve().then(async () => {
			this.shutdownController.abort();
			const clients = [...this.clients];
			this.clients.clear();
			const results = await Promise.allSettled(
				clients.map((client) => Promise.resolve().then(() => client.close())),
			);
			if (results.some((result) => result.status === "rejected")) {
				this.options.log("mcp client shutdown failed");
			}
		});
		return this.closePromise;
	}

	private async initialize(connectOptions?: McpConnectOptions): Promise<void> {
		this.servers.clear();
		this.discoveredOAuth.clear();
		this.startedWithOAuthFlow = !!connectOptions?.requestOAuthTokens;
		let configs: ResolvedMcpServerConfig[] = [];
		try {
			configs = await resolveMcpServers(this.options.workingDir);
		} catch (error) {
			this.options.log(
				`failed to resolve mcp servers: ${describeError(error)}`,
			);
			return;
		}
		if (this.closed) return;

		if (
			configs.some((config) => config.enabled && config.transport !== "stdio")
		) {
			try {
				this.authFile = await this.authStore.load();
			} catch (error) {
				this.options.log(
					`failed to load mcp-auth.json: ${describeError(error)}`,
				);
				this.authFile = { version: MCP_AUTH_VERSION, servers: {} };
			}
			if (this.closed) return;
		}

		for (const config of configs) {
			this.servers.set(config.id, {
				config,
				state: config.enabled ? "connecting" : "disabled",
				tools_count: 0,
				toolAdapters: [],
			});
		}

		const tasks = configs
			.filter((config) => config.enabled)
			.map((config) => this.connectServer(config.id, connectOptions));
		await Promise.allSettled(tasks);
	}

	private async connectServer(
		serverId: string,
		connectOptions?: McpConnectOptions,
	): Promise<void> {
		const runtime = this.servers.get(serverId);
		if (!runtime || this.closed) return;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.closed) return;
			runtime.state = "connecting";
			connectOptions?.onStatus?.(`Connecting MCP server: ${serverId}`);
			try {
				const client = await this.createClient(runtime.config);
				if (this.closed) {
					await client.close();
					return;
				}
				this.clients.add(client);
				runtime.client = client;
				const protocolVersion = getMcpProtocolVersion();
				const initializeResult = await client.request(
					"initialize",
					{
						protocolVersion,
						clientInfo: {
							name: "codelia-runtime",
							version: "0.1.0",
						},
						capabilities: {},
					},
					{ timeoutMs: runtime.config.request_timeout_ms },
				);
				if (this.closed) return;
				const negotiatedProtocol =
					getInitializeProtocolVersion(initializeResult);
				if (
					negotiatedProtocol &&
					!isSupportedMcpProtocolVersion(negotiatedProtocol)
				) {
					throw new Error(
						`unsupported protocol version: ${negotiatedProtocol} (supported: ${getMcpCompatibleProtocolVersions().join(", ")})`,
					);
				}
				if (negotiatedProtocol && negotiatedProtocol !== protocolVersion) {
					this.options.log(
						`mcp[${serverId}] using compatible protocol version ${negotiatedProtocol}`,
					);
				}

				await client.notify("notifications/initialized", {});
				if (this.closed) return;
				const supportsTools = hasToolCapability(initializeResult);
				const tools = supportsTools
					? await this.fetchAllTools(client, runtime.config.request_timeout_ms)
					: [];
				if (this.closed) return;
				runtime.toolAdapters = tools.map((tool) =>
					this.createToolAdapter(
						runtime.config.id,
						tool,
						runtime.config,
						client,
					),
				);
				runtime.tools_count = runtime.toolAdapters.length;
				runtime.state = "ready";
				runtime.last_error = undefined;
				runtime.last_connected_at = nowIso();
				connectOptions?.onStatus?.(
					`MCP server ready: ${serverId} (${runtime.tools_count ?? 0} tools)`,
				);
				return;
			} catch (error) {
				if (this.closed) return;
				if (attempt === 0 && isAuthRequiredError(error)) {
					const oauth = await this.resolveOAuthConfig(runtime.config);
					if (this.closed) return;
					const hasOAuthFlow = !!oauth.authorization_url && !!oauth.token_url;
					if (hasOAuthFlow && connectOptions?.requestOAuthTokens) {
						const prompted = await this.requestOAuthTokensForServer(
							serverId,
							runtime.config,
							describeError(error),
							connectOptions,
						);
						if (this.closed) return;
						if (prompted) {
							if (runtime.client) {
								await runtime.client.close().catch(() => undefined);
								this.clients.delete(runtime.client);
								runtime.client = undefined;
							}
							connectOptions.onStatus?.(
								`Retrying MCP server with OAuth token: ${serverId}`,
							);
							continue;
						}
					}
					if (hasOAuthFlow) {
						runtime.state = "auth_required";
						runtime.last_error = undefined;
						runtime.toolAdapters = [];
						runtime.tools_count = 0;
						this.options.log(
							`mcp[${serverId}] OAuth required; waiting for sign-in`,
						);
						connectOptions?.onStatus?.(`MCP auth required: ${serverId}`);
						if (runtime.client) {
							await runtime.client.close().catch(() => undefined);
							this.clients.delete(runtime.client);
							runtime.client = undefined;
						}
						return;
					}
				}
				runtime.state = "error";
				runtime.last_error = describeError(error);
				runtime.toolAdapters = [];
				runtime.tools_count = 0;
				this.options.log(
					`mcp[${serverId}] connect failed: ${runtime.last_error}`,
				);
				connectOptions?.onStatus?.(
					`MCP server error: ${serverId} (${runtime.last_error})`,
				);
				if (runtime.client) {
					await runtime.client.close().catch(() => undefined);
					this.clients.delete(runtime.client);
					runtime.client = undefined;
				}
				return;
			}
		}
	}

	private getStoredTokens(
		serverId: string,
		config: ResolvedMcpServerConfig,
		oauth?: ResolvedOAuthConfig,
	): McpOAuthTokens | undefined {
		const entry = this.authFile.servers[serverId];
		if (!entry) return undefined;
		if (!mcpEntryMatchesServer(entry, config, oauth)) {
			this.options.log(
				`mcp[${serverId}] stored token binding mismatch; re-authentication required`,
			);
			return undefined;
		}
		return entry.tokens;
	}

	private async requestOAuthTokensForServer(
		serverId: string,
		config: ResolvedMcpServerConfig,
		reason: string,
		connectOptions?: McpConnectOptions,
	): Promise<boolean> {
		if (!connectOptions?.requestOAuthTokens) {
			return false;
		}
		try {
			const oauth = await this.resolveOAuthConfig(config);
			if (this.closed) return false;
			if (!oauth.authorization_url || !oauth.token_url) {
				this.options.log(
					`mcp[${serverId}] OAuth metadata unavailable; skipping OAuth prompt`,
				);
				return false;
			}
			connectOptions.onStatus?.(`MCP auth required: ${serverId}`);
			const provided = await connectOptions.requestOAuthTokens({
				server_id: serverId,
				error: reason,
				oauth,
				signal: this.shutdownController.signal,
			});
			if (this.closed || !provided?.access_token) {
				return false;
			}
			const nextTokens: McpOAuthTokens = {
				...provided,
				...(oauth.client_id && !provided.client_id
					? { client_id: oauth.client_id }
					: {}),
				...(oauth.client_secret && !provided.client_secret
					? { client_secret: oauth.client_secret }
					: {}),
			};
			const binding = resolveMcpServerBinding(config, {
				...oauth,
				client_id: nextTokens.client_id ?? oauth.client_id,
			});
			if (!binding) {
				this.options.log(
					`mcp[${serverId}] cannot bind OAuth token without a valid server URL`,
				);
				return false;
			}
			await this.persistTokens(serverId, binding, nextTokens);
			return true;
		} catch (error) {
			this.options.log(
				`mcp[${serverId}] OAuth prompt failed: ${describeError(error)}`,
			);
			return false;
		}
	}

	private async persistTokens(
		serverId: string,
		binding: McpServerAuthBinding,
		tokens: McpOAuthTokens,
	): Promise<void> {
		this.authFile = await this.authStore.update((latest) => {
			this.shutdownController.signal.throwIfAborted();
			latest.servers[serverId] = { binding, tokens };
			return latest;
		});
	}

	private isStoredTokenReusable(
		tokens: McpOAuthTokens | undefined,
		failedAccessToken?: string,
	): boolean {
		if (!tokens?.access_token) return false;
		if (failedAccessToken !== undefined) {
			return tokens.access_token !== failedAccessToken;
		}
		return (
			!tokens.expires_at ||
			tokens.expires_at > Date.now() + OAUTH_TOKEN_EXPIRY_SKEW_MS
		);
	}

	private async getServerAccessToken(
		serverId: string,
		config: ResolvedMcpServerConfig,
	): Promise<string | undefined> {
		const entry = this.authFile.servers[serverId];
		if (!entry) return undefined;
		const oauth =
			entry.binding.issuer || entry.binding.token_endpoint
				? await this.discoverOAuthConfig(config)
				: undefined;
		const tokens = this.getStoredTokens(serverId, config, oauth);
		if (!tokens?.access_token) return undefined;
		if (
			tokens.expires_at &&
			tokens.expires_at <= Date.now() + OAUTH_TOKEN_EXPIRY_SKEW_MS
		) {
			const refreshed = await this.refreshServerAccessToken(serverId, config);
			if (refreshed || this.closed) return refreshed;
		}
		return tokens.access_token;
	}

	private async refreshServerAccessToken(
		serverId: string,
		config: ResolvedMcpServerConfig,
		reason = "token refresh requested",
		failedAccessToken?: string,
	): Promise<string | undefined> {
		// Reload first so we can reuse a token already rotated by a sibling process,
		// but ALWAYS confirm OAuth discovery / issuer binding before trusting it.
		if (this.closed) return undefined;
		this.authFile = await this.authStore.load();
		const oauth = await this.resolveOAuthConfig(config);
		if (this.closed) return undefined;
		const initial = this.getStoredTokens(serverId, config, oauth);
		if (initial && this.isStoredTokenReusable(initial, failedAccessToken)) {
			return initial.access_token;
		}
		if (!initial?.refresh_token) {
			const prompted = await this.requestOAuthTokensForServer(
				serverId,
				config,
				reason,
				{ requestOAuthTokens: this.requestOAuthTokensCallback },
			);
			return prompted
				? this.getStoredTokens(serverId, config, oauth)?.access_token
				: undefined;
		}
		if (!oauth.token_url) {
			this.options.log(
				`mcp[${serverId}] token refresh skipped: token_url not configured/discovered`,
			);
			const prompted = await this.requestOAuthTokensForServer(
				serverId,
				config,
				`${reason} (token endpoint unavailable)`,
				{ requestOAuthTokens: this.requestOAuthTokensCallback },
			);
			return prompted
				? this.getStoredTokens(serverId, config, oauth)?.access_token
				: undefined;
		}
		const tokenUrl = oauth.token_url;
		const expectedBinding = resolveMcpServerBinding(config, oauth);
		if (!expectedBinding) {
			return undefined;
		}
		const refreshTimeoutMs =
			this.options.refreshTimeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
		try {
			const outcome = await this.authStore.update<
				| { status: "reused"; token: string; auth: McpAuthFile }
				| { status: "refreshed"; token: string; auth: McpAuthFile }
				| { status: "needs_prompt"; auth: McpAuthFile }
			>(async (auth) => {
				this.shutdownController.signal.throwIfAborted();
				const entry = auth.servers[serverId];
				if (!entry || !mcpEntryMatchesServer(entry, config, oauth)) {
					return { status: "needs_prompt", auth };
				}
				const current = entry.tokens;
				if (current && this.isStoredTokenReusable(current, failedAccessToken)) {
					return { status: "reused", token: current.access_token, auth };
				}
				if (!current?.refresh_token || !entry.binding.token_endpoint) {
					return { status: "needs_prompt", auth };
				}
				const form = new URLSearchParams();
				form.set("grant_type", "refresh_token");
				form.set("refresh_token", current.refresh_token);
				const clientId = config.oauth?.client_id ?? current.client_id;
				const clientSecret =
					config.oauth?.client_secret ?? current.client_secret;
				const scope = config.oauth?.scope ?? current.scope ?? oauth.scope;
				if (clientId) {
					form.set("client_id", clientId);
				}
				if (clientSecret) {
					form.set("client_secret", clientSecret);
				}
				if (scope) {
					form.set("scope", scope);
				}
				if (oauth.resource) {
					form.set("resource", oauth.resource);
				}
				const timeoutController = new AbortController();
				const signal = AbortSignal.any([
					this.shutdownController.signal,
					timeoutController.signal,
				]);
				let timedOut = false;
				const timer = setTimeout(() => {
					timedOut = true;
					timeoutController.abort(
						new Error("MCP OAuth token refresh timed out"),
					);
				}, refreshTimeoutMs);
				let payload: unknown;
				try {
					const response = await fetch(tokenUrl, {
						redirect: "error",
						method: "POST",
						signal,
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							Accept: "application/json",
						},
						body: form.toString(),
					});
					if (!response.ok) {
						const body = await awaitWithAbort(response.text(), signal).catch(
							() => "",
						);
						const snippet = body ? body.slice(0, 500) : "(empty)";
						throw new Error(`refresh failed (${response.status}): ${snippet}`);
					}
					payload = await awaitWithAbort(response.json(), signal);
				} catch (error) {
					if (timedOut) {
						throw new Error("MCP OAuth token refresh timed out");
					}
					throw error;
				} finally {
					clearTimeout(timer);
				}
				const updated = parseTokenResponse(payload, {
					...current,
					...(clientId ? { client_id: clientId } : {}),
					...(clientSecret ? { client_secret: clientSecret } : {}),
				});
				const updatedBinding =
					resolveMcpServerBinding(config, {
						...oauth,
						client_id: updated.client_id ?? oauth.client_id,
					}) ?? expectedBinding;
				auth.servers[serverId] = { binding: updatedBinding, tokens: updated };
				return { status: "refreshed", token: updated.access_token, auth };
			});
			this.authFile = outcome.auth;
			if (this.closed) return undefined;
			if (outcome.status === "needs_prompt") {
				const prompted = await this.requestOAuthTokensForServer(
					serverId,
					config,
					reason,
					{ requestOAuthTokens: this.requestOAuthTokensCallback },
				);
				return prompted
					? this.getStoredTokens(serverId, config, oauth)?.access_token
					: undefined;
			}
			return outcome.token;
		} catch (error) {
			if (this.closed) return undefined;
			this.options.log(
				`mcp[${serverId}] token refresh failed: ${describeError(error)}`,
			);
			const prompted = await this.requestOAuthTokensForServer(
				serverId,
				config,
				`${reason} (${describeError(error)})`,
				{ requestOAuthTokens: this.requestOAuthTokensCallback },
			);
			return prompted
				? this.getStoredTokens(serverId, config, oauth)?.access_token
				: undefined;
		}
	}

	private async resolveOAuthConfig(
		config: ResolvedMcpServerConfig,
	): Promise<ResolvedOAuthConfig> {
		// Discover OAuth metadata FIRST before looking up stored client_id /
		// client_secret so credentials are NEVER reused across changed issuers.
		const discovered = await this.discoverOAuthConfig(config);
		const baseOAuth: ResolvedOAuthConfig = {
			...(discovered.issuer ? { issuer: discovered.issuer } : {}),
			authorization_url:
				config.oauth?.authorization_url ?? discovered.authorization_url,
			token_url: config.oauth?.token_url ?? discovered.token_url,
			registration_url:
				config.oauth?.registration_url ?? discovered.registration_url,
			resource: discovered.resource ?? config.url,
			scope: config.oauth?.scope ?? discovered.scope,
			code_challenge_methods_supported:
				discovered.code_challenge_methods_supported,
			client_id: config.oauth?.client_id,
			client_secret: config.oauth?.client_secret,
		};
		const stored = this.getStoredTokens(config.id, config, baseOAuth);
		return {
			...baseOAuth,
			client_id: baseOAuth.client_id ?? stored?.client_id,
			client_secret:
				baseOAuth.client_secret ??
				(this.authFile.servers[config.id]?.binding.token_endpoint
					? stored?.client_secret
					: undefined),
		};
	}

	private async discoverOAuthConfig(
		config: ResolvedMcpServerConfig,
	): Promise<ResolvedOAuthConfig> {
		if (config.transport !== "http" || !config.url) return {};
		const cached = this.discoveredOAuth.get(config.id);
		if (cached) return cached;
		const discovered = await this.fetchDiscoveredOAuthConfig(config.url);
		this.discoveredOAuth.set(config.id, discovered);
		return discovered;
	}

	private fetchDiscoveredOAuthConfig(
		serverUrl: string,
	): Promise<DiscoveredOAuthConfig> {
		return fetchDiscoveredOAuthConfig(
			serverUrl,
			this.shutdownController.signal,
		);
	}

	private async createClient(
		config: ResolvedMcpServerConfig,
	): Promise<McpClient> {
		if (config.transport === "stdio") {
			const child = this.options.spawnStdio
				? await this.options.spawnStdio(config, this.shutdownController.signal)
				: undefined;
			return new StdioMcpClient(
				{
					serverId: config.id,
					command: config.command ?? "",
					args: config.args ?? [],
					cwd: config.cwd,
					env: config.env,
					log: this.options.log,
				},
				child,
			);
		}
		return new HttpMcpClient({
			serverId: config.id,
			url: config.url ?? "",
			headers: config.headers,
			protocolVersion: getMcpProtocolVersion(),
			log: this.options.log,
			getAccessToken: () => this.getServerAccessToken(config.id, config),
			refreshAccessToken: (failedAccessToken) =>
				this.refreshServerAccessToken(
					config.id,
					config,
					"MCP HTTP 401 during request",
					failedAccessToken,
				),
		});
	}

	private fetchAllTools(
		client: McpClient,
		timeoutMs: number,
	): Promise<McpToolDescriptor[]> {
		return fetchAllMcpTools(client, timeoutMs);
	}

	private createToolAdapter(
		serverId: string,
		tool: McpToolDescriptor,
		config: ResolvedMcpServerConfig,
		client: McpClient,
	): Tool {
		return createMcpToolAdapter({
			serverId,
			tool,
			config,
			client,
			describeError,
		});
	}
}
