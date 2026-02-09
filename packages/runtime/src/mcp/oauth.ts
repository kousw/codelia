import {
	generatePkce,
	generateState,
	type OAuthPkce,
	readPositiveIntEnv,
	startOAuthCallbackServer,
} from "../auth/oauth-utils";
import type { McpOAuthTokens } from "./auth-store";

const DEFAULT_MCP_OAUTH_PORT = 1456;
const DEFAULT_MCP_OAUTH_WAIT_TIMEOUT_MS = 180_000;

const HTML_SUCCESS =
	"<!doctype html><html><head><title>codelia - MCP authorization successful</title></head><body><h2>Authorization successful</h2><p>You can close this window.</p></body></html>";
const HTML_ERROR = (message: string) =>
	`<!doctype html><html><head><title>codelia - MCP authorization failed</title></head><body><h2>Authorization failed</h2><pre>${message}</pre></body></html>`;

type OAuthClientCredentials = {
	client_id: string;
	client_secret?: string;
};

export type McpOAuthSessionParams = {
	server_id: string;
	authorization_url: string;
	token_url: string;
	registration_url?: string;
	scope?: string;
	resource?: string;
	client_id?: string;
	client_secret?: string;
	code_challenge_methods_supported?: string[];
};

export type McpOAuthSession = {
	authUrl: string;
	redirectUri: string;
	clientId: string;
	waitForTokens: () => Promise<McpOAuthTokens>;
	stop: () => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const oauthPort = (): number =>
	readPositiveIntEnv("CODELIA_MCP_OAUTH_PORT", DEFAULT_MCP_OAUTH_PORT);

const oauthWaitTimeoutMs = (): number =>
	readPositiveIntEnv(
		"CODELIA_MCP_OAUTH_TIMEOUT_MS",
		DEFAULT_MCP_OAUTH_WAIT_TIMEOUT_MS,
	);

const buildAuthorizeUrl = (
	authorizationUrl: string,
	redirectUri: string,
	clientId: string,
	pkce: OAuthPkce,
	state: string,
	scope?: string,
	resource?: string,
): string => {
	const url = new URL(authorizationUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", clientId);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	if (scope?.trim()) {
		url.searchParams.set("scope", scope.trim());
	}
	if (resource?.trim()) {
		url.searchParams.set("resource", resource.trim());
	}
	return url.toString();
};

const ensureJsonResponse = async (
	response: Response,
	errorLabel: string,
): Promise<unknown> => {
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		const snippet = body ? body.slice(0, 500) : "(empty)";
		throw new Error(`${errorLabel} (${response.status}): ${snippet}`);
	}
	return (await response.json()) as unknown;
};

const parseTokenPayload = (
	value: unknown,
	creds: OAuthClientCredentials,
): McpOAuthTokens => {
	if (!isRecord(value) || typeof value.access_token !== "string") {
		throw new Error("OAuth token response missing access_token");
	}
	const expiresIn =
		typeof value.expires_in === "number" && Number.isFinite(value.expires_in)
			? value.expires_in
			: undefined;
	return {
		access_token: value.access_token,
		...(typeof value.refresh_token === "string"
			? { refresh_token: value.refresh_token }
			: {}),
		...(typeof value.token_type === "string"
			? { token_type: value.token_type }
			: {}),
		...(typeof value.scope === "string" ? { scope: value.scope } : {}),
		...(expiresIn
			? { expires_at: Date.now() + Math.round(expiresIn * 1000) }
			: {}),
		client_id: creds.client_id,
		...(creds.client_secret ? { client_secret: creds.client_secret } : {}),
	};
};

const exchangeCodeForTokens = async (
	code: string,
	redirectUri: string,
	pkce: OAuthPkce,
	tokenUrl: string,
	creds: OAuthClientCredentials,
	resource?: string,
): Promise<McpOAuthTokens> => {
	const form = new URLSearchParams();
	form.set("grant_type", "authorization_code");
	form.set("code", code);
	form.set("redirect_uri", redirectUri);
	form.set("client_id", creds.client_id);
	form.set("code_verifier", pkce.verifier);
	if (creds.client_secret) {
		form.set("client_secret", creds.client_secret);
	}
	if (resource?.trim()) {
		form.set("resource", resource.trim());
	}
	const response = await fetch(tokenUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: form.toString(),
	});
	const payload = await ensureJsonResponse(
		response,
		"MCP OAuth token exchange failed",
	);
	return parseTokenPayload(payload, creds);
};

const registerDynamicClient = async (
	registrationUrl: string,
	redirectUri: string,
	serverId: string,
): Promise<OAuthClientCredentials> => {
	const payload = {
		client_name: `codelia (${serverId})`,
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};
	const response = await fetch(registrationUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(payload),
	});
	const parsed = await ensureJsonResponse(
		response,
		"MCP OAuth dynamic client registration failed",
	);
	if (!isRecord(parsed) || typeof parsed.client_id !== "string") {
		throw new Error(
			"MCP OAuth dynamic registration response missing client_id",
		);
	}
	return {
		client_id: parsed.client_id,
		...(typeof parsed.client_secret === "string"
			? { client_secret: parsed.client_secret }
			: {}),
	};
};

const supportsPkceS256 = (methods?: string[]): boolean => {
	if (!methods?.length) {
		return true;
	}
	return methods.some((entry) => entry.toUpperCase() === "S256");
};

export const createMcpOAuthSession = async (
	params: McpOAuthSessionParams,
): Promise<McpOAuthSession> => {
	if (!supportsPkceS256(params.code_challenge_methods_supported)) {
		throw new Error("authorization server does not support PKCE S256");
	}

	const pkce = await generatePkce();
	const state = generateState();
	const port = oauthPort();
	const waitTimeoutMs = oauthWaitTimeoutMs();
	const redirectUri = `http://localhost:${port}/mcp/oauth/callback`;
	let credentials: OAuthClientCredentials;
	if (params.client_id?.trim()) {
		credentials = {
			client_id: params.client_id.trim(),
			...(params.client_secret?.trim()
				? { client_secret: params.client_secret.trim() }
				: {}),
		};
	} else if (params.registration_url?.trim()) {
		credentials = await registerDynamicClient(
			params.registration_url.trim(),
			redirectUri,
			params.server_id,
		);
	} else {
		throw new Error(
			"MCP OAuth client_id is missing. Set mcp.servers.<id>.oauth.client_id or use a server with registration_endpoint.",
		);
	}

	const authUrl = buildAuthorizeUrl(
		params.authorization_url,
		redirectUri,
		credentials.client_id,
		pkce,
		state,
		params.scope,
		params.resource,
	);

	const callbackServer = startOAuthCallbackServer<McpOAuthTokens>({
		port,
		callbackPath: "/mcp/oauth/callback",
		cancelPath: "/mcp/oauth/cancel",
		expectedState: state,
		successHtml: HTML_SUCCESS,
		errorHtml: HTML_ERROR,
		timeoutMs: waitTimeoutMs,
		timeoutMessage: `MCP OAuth timed out waiting for callback (${Math.round(waitTimeoutMs / 1000)}s)`,
		invalidStateMessage: "invalid oauth state",
		cancelMessage: "oauth cancelled",
		onCode: (code) =>
			exchangeCodeForTokens(
				code,
				redirectUri,
				pkce,
				params.token_url,
				credentials,
				params.resource,
			),
	});

	return {
		authUrl,
		redirectUri,
		clientId: credentials.client_id,
		waitForTokens: callbackServer.waitForResult,
		stop: callbackServer.stop,
	};
};
