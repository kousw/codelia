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
import { type ResolvedMcpServerConfig, resolveMcpServers } from "../config";
import {
	type McpAuthFile,
	McpAuthStore,
	type McpOAuthTokens,
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
	parseTokenResponse,
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
	log: (message: string) => void;
};

export type McpConnectOptions = {
	onStatus?: (message: string) => void;
	requestOAuthTokens?: (params: {
		server_id: string;
		error: string;
		oauth: McpOAuthPromptConfig;
	}) => Promise<McpOAuthTokens | null>;
};

const isAuthRequiredError = (error: unknown): boolean => {
	if (isMcpHttpAuthError(error)) return true;
	const message = describeError(error).toLowerCase();
	return message.includes("mcp http 401") || message.includes("unauthorized");
};

export class McpManager {
	private readonly servers = new Map<string, McpServerRuntime>();
	private readonly authStore = new McpAuthStore();
	private startPromise: Promise<void> | null = null;
	private authFile: McpAuthFile = { version: 1, servers: {} };
	private readonly discoveredOAuth = new Map<string, DiscoveredOAuthConfig>();
	private startedWithOAuthFlow = false;
	private requestOAuthTokensCallback?: McpConnectOptions["requestOAuthTokens"];

	constructor(private readonly options: ManagerOptions) {}

	start(connectOptions?: McpConnectOptions): Promise<void> {
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

	list(scope: McpListScope = "loaded"): McpListResult {
		const servers = Array.from(this.servers.entries())
			.map(([id, runtime]) => toListServer(id, runtime))
			.sort((left, right) => left.id.localeCompare(right.id));
		if (scope === "configured") {
			return { servers };
		}
		return { servers };
	}

	async close(): Promise<void> {
		const closeTasks = Array.from(this.servers.values())
			.map((entry) => entry.client)
			.filter((client): client is McpClient => !!client)
			.map((client) => client.close());
		await Promise.allSettled(closeTasks);
	}

	private async initialize(connectOptions?: McpConnectOptions): Promise<void> {
		this.servers.clear();
		this.discoveredOAuth.clear();
		this.startedWithOAuthFlow = !!connectOptions?.requestOAuthTokens;
		try {
			this.authFile = await this.authStore.load();
		} catch (error) {
			this.options.log(`failed to load mcp-auth.json: ${describeError(error)}`);
			this.authFile = { version: 1, servers: {} };
		}
		let configs: ResolvedMcpServerConfig[] = [];
		try {
			configs = await resolveMcpServers(this.options.workingDir);
		} catch (error) {
			this.options.log(
				`failed to resolve mcp servers: ${describeError(error)}`,
			);
			return;
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
		if (!runtime) return;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			runtime.state = "connecting";
			connectOptions?.onStatus?.(`Connecting MCP server: ${serverId}`);
			try {
				const client = this.createClient(runtime.config);
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
				const supportsTools = hasToolCapability(initializeResult);
				const tools = supportsTools
					? await this.fetchAllTools(client, runtime.config.request_timeout_ms)
					: [];
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
				if (attempt === 0 && isAuthRequiredError(error)) {
					const oauth = await this.resolveOAuthConfig(runtime.config);
					const hasOAuthFlow = !!oauth.authorization_url && !!oauth.token_url;
					if (hasOAuthFlow && connectOptions?.requestOAuthTokens) {
						const prompted = await this.requestOAuthTokensForServer(
							serverId,
							runtime.config,
							describeError(error),
							connectOptions,
						);
						if (prompted) {
							if (runtime.client) {
								await runtime.client.close().catch(() => undefined);
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
					runtime.client = undefined;
				}
				return;
			}
		}
	}

	private getStoredTokens(serverId: string): McpOAuthTokens | undefined {
		return this.authFile.servers[serverId];
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
			});
			if (!provided?.access_token) {
				return false;
			}
			await this.persistTokens(serverId, {
				...provided,
				...(oauth.client_id && !provided.client_id
					? { client_id: oauth.client_id }
					: {}),
				...(oauth.client_secret && !provided.client_secret
					? { client_secret: oauth.client_secret }
					: {}),
			});
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
		tokens: McpOAuthTokens,
	): Promise<void> {
		this.authFile.servers[serverId] = tokens;
		await this.authStore.save(this.authFile);
	}

	private async getServerAccessToken(
		serverId: string,
		config: ResolvedMcpServerConfig,
	): Promise<string | undefined> {
		const tokens = this.getStoredTokens(serverId);
		if (!tokens?.access_token) return undefined;
		if (
			tokens.expires_at &&
			tokens.expires_at <= Date.now() + OAUTH_TOKEN_EXPIRY_SKEW_MS
		) {
			const refreshed = await this.refreshServerAccessToken(serverId, config);
			if (refreshed) return refreshed;
		}
		return tokens.access_token;
	}

	private async refreshServerAccessToken(
		serverId: string,
		config: ResolvedMcpServerConfig,
		reason = "token refresh requested",
	): Promise<string | undefined> {
		const current = this.getStoredTokens(serverId);
		if (!current?.refresh_token) {
			const prompted = await this.requestOAuthTokensForServer(
				serverId,
				config,
				reason,
				{ requestOAuthTokens: this.requestOAuthTokensCallback },
			);
			return prompted
				? this.getStoredTokens(serverId)?.access_token
				: undefined;
		}
		const oauth = await this.resolveOAuthConfig(config);
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
				? this.getStoredTokens(serverId)?.access_token
				: undefined;
		}
		try {
			const form = new URLSearchParams();
			form.set("grant_type", "refresh_token");
			form.set("refresh_token", current.refresh_token);
			const clientId = config.oauth?.client_id ?? current.client_id;
			const clientSecret = config.oauth?.client_secret ?? current.client_secret;
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
			const response = await fetch(oauth.token_url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: form.toString(),
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				const snippet = body ? body.slice(0, 500) : "(empty)";
				throw new Error(`refresh failed (${response.status}): ${snippet}`);
			}
			const payload = (await response.json()) as unknown;
			const updated = parseTokenResponse(payload, {
				...current,
				...(clientId ? { client_id: clientId } : {}),
				...(clientSecret ? { client_secret: clientSecret } : {}),
			});
			await this.persistTokens(serverId, updated);
			return updated.access_token;
		} catch (error) {
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
				? this.getStoredTokens(serverId)?.access_token
				: undefined;
		}
	}

	private async resolveOAuthConfig(
		config: ResolvedMcpServerConfig,
	): Promise<ResolvedOAuthConfig> {
		const stored = this.getStoredTokens(config.id);
		const discovered = await this.discoverOAuthConfig(config);
		return {
			authorization_url:
				config.oauth?.authorization_url ?? discovered.authorization_url,
			token_url: config.oauth?.token_url ?? discovered.token_url,
			registration_url:
				config.oauth?.registration_url ?? discovered.registration_url,
			resource: discovered.resource ?? config.url,
			scope: config.oauth?.scope ?? discovered.scope,
			code_challenge_methods_supported:
				discovered.code_challenge_methods_supported,
			client_id: config.oauth?.client_id ?? stored?.client_id,
			client_secret: config.oauth?.client_secret ?? stored?.client_secret,
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
		return fetchDiscoveredOAuthConfig(serverUrl);
	}

	private createClient(config: ResolvedMcpServerConfig): McpClient {
		if (config.transport === "stdio") {
			return new StdioMcpClient({
				serverId: config.id,
				command: config.command ?? "",
				args: config.args ?? [],
				cwd: config.cwd,
				env: config.env,
				log: this.options.log,
			});
		}
		return new HttpMcpClient({
			serverId: config.id,
			url: config.url ?? "",
			headers: config.headers,
			protocolVersion: getMcpProtocolVersion(),
			log: this.options.log,
			getAccessToken: () => this.getServerAccessToken(config.id, config),
			refreshAccessToken: () =>
				this.refreshServerAccessToken(
					config.id,
					config,
					"MCP HTTP 401 during request",
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
