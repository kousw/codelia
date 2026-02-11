import { spawn } from "node:child_process";
import { log } from "../logger";
import {
	generatePkce,
	generateState,
	type OAuthPkce,
	readPositiveIntEnv,
	startOAuthCallbackServer,
} from "./oauth-utils";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEFAULT_PORT = 1455;
const OAUTH_SCOPE = "openid profile email offline_access";

export const OPENAI_OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";

const HTML_SUCCESS =
	"<!doctype html><html><head><title>codelia - Authorization successful</title></head><body><h2>Authorization successful</h2><p>You can close this window.</p></body></html>";
const HTML_ERROR = (message: string) =>
	`<!doctype html><html><head><title>codelia - Authorization failed</title></head><body><h2>Authorization failed</h2><pre>${message}</pre></body></html>`;

export type OpenAiTokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in?: number;
	id_token?: string;
};

type OAuthSession = {
	authUrl: string;
	waitForTokens: () => Promise<OpenAiTokenResponse>;
	stop: () => void;
	redirectUri: string;
};

type BrowserLaunch = {
	command: string;
	args: string[];
	options: {
		stdio: "ignore";
		detached: true;
		windowsHide?: true;
		shell?: true;
	};
};

const clientId = (): string =>
	process.env.CODELIA_OPENAI_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID;

const oauthPort = (): number =>
	readPositiveIntEnv("CODELIA_OPENAI_OAUTH_PORT", DEFAULT_PORT);

const buildAuthorizeUrl = (
	redirectUri: string,
	pkce: OAuthPkce,
	state: string,
): string => {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId(),
		redirect_uri: redirectUri,
		scope: OAUTH_SCOPE,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		state,
		originator: "codelia",
	});
	return `${ISSUER}/oauth/authorize?${params.toString()}`;
};

const requestToken = async (
	params: Record<string, string>,
	errorLabel: string,
): Promise<OpenAiTokenResponse> => {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	if (!response.ok) {
		throw new Error(`${errorLabel} (${response.status})`);
	}
	return response.json();
};

export const exchangeCodeForTokens = async (
	code: string,
	redirectUri: string,
	pkce: OAuthPkce,
): Promise<OpenAiTokenResponse> => {
	return requestToken(
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: clientId(),
			code_verifier: pkce.verifier,
		},
		"token exchange failed",
	);
};

export const refreshAccessToken = async (
	refreshToken: string,
): Promise<OpenAiTokenResponse> => {
	return requestToken(
		{
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: clientId(),
		},
		"token refresh failed",
	);
};

const parseJwt = (token: string): Record<string, unknown> | null => {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	try {
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch {
		return null;
	}
};

export const extractAccountId = (
	tokens: OpenAiTokenResponse,
): string | undefined => {
	const token = tokens.id_token ?? tokens.access_token;
	if (!token) return undefined;
	const claims = parseJwt(token);
	if (!claims) return undefined;
	return (
		((claims as { chatgpt_account_id?: string }).chatgpt_account_id as
			| string
			| undefined) ||
		((
			claims["https://api.openai.com/auth"] as
				| { chatgpt_account_id?: string }
				| undefined
		)?.chatgpt_account_id as string | undefined) ||
		((claims.organizations as Array<{ id?: string }> | undefined)?.[0]?.id as
			| string
			| undefined)
	);
};

export const createOAuthSession = async (): Promise<OAuthSession> => {
	const pkce = await generatePkce();
	const state = generateState();
	const port = oauthPort();
	const redirectUri = `http://localhost:${port}/auth/callback`;
	const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

	const callbackServer = startOAuthCallbackServer<OpenAiTokenResponse>({
		port,
		callbackPath: "/auth/callback",
		cancelPath: "/cancel",
		expectedState: state,
		successHtml: HTML_SUCCESS,
		errorHtml: HTML_ERROR,
		cancelMessage: "login cancelled",
		onServerError: (error) => {
			log(`oauth server error: ${String(error)}`);
		},
		onCode: (code) => exchangeCodeForTokens(code, redirectUri, pkce),
	});

	return {
		authUrl,
		redirectUri,
		waitForTokens: callbackServer.waitForResult,
		stop: callbackServer.stop,
	};
};

export const resolveBrowserLaunch = (
	platform: NodeJS.Platform,
	url: string,
): BrowserLaunch => {
	if (platform === "darwin") {
		return {
			command: "open",
			args: [url],
			options: { stdio: "ignore", detached: true },
		};
	}
	if (platform === "win32") {
		// Avoid `cmd /c start ...` to prevent shell from splitting query params on '&'.
		return {
			command: "rundll32",
			args: ["url.dll,FileProtocolHandler", url],
			options: {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			},
		};
	}
	return {
		command: "xdg-open",
		args: [url],
		options: { stdio: "ignore", detached: true },
	};
};

export const openBrowser = (url: string): void => {
	const launch = resolveBrowserLaunch(process.platform, url);
	try {
		spawn(launch.command, launch.args, launch.options);
	} catch {
		// ignore open failures
	}
};
