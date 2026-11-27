import { spawn } from "node:child_process";
import { ProviderFailureError, type ProviderFailureKind } from "@codelia/core";
import { DEFAULT_OAUTH_REFRESH_TIMEOUT_MS } from "@codelia/storage";
import { log } from "../logger";
import {
	generatePkce,
	generateState,
	type OAuthPkce,
	readOAuthCallbackCode,
	readPositiveIntEnv,
	startOAuthCallbackServer,
} from "./oauth-utils";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEFAULT_PORT = 1455;
const OAUTH_SCOPE = "openid profile email offline_access";

export const OPENAI_OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_OAUTH_ORIGINATOR = "codelia";
export const OPENAI_OAUTH_USER_AGENT = "codelia-cli";

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

type OAuthCallbackMode = "server" | "paste";

type OAuthSession = {
	authUrl: string;
	waitForTokens: () => Promise<OpenAiTokenResponse>;
	completeFromInput: (input: string) => Promise<OpenAiTokenResponse>;
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

const clientId = (): string => DEFAULT_CLIENT_ID;

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

const withSignalAbort = <T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> => {
	if (!signal) return promise;
	if (signal.aborted) {
		return Promise.reject(
			signal.reason instanceof Error
				? signal.reason
				: new Error("Request aborted"),
		);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new Error("Request aborted"),
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

const requestToken = async (
	params: Record<string, string>,
	operation: "refresh" | "exchange",
	signal?: AbortSignal,
): Promise<OpenAiTokenResponse> => {
	const response = await fetch(`${ISSUER}/oauth/token`, {
		method: "POST",
		redirect: "error",
		signal,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	if (!response.ok) {
		throw await withSignalAbort(tokenFailure(response, operation), signal);
	}
	return withSignalAbort(response.json(), signal);
};

const oauthReasons = {
	refresh_token_reused: "The refresh token has already been used.",
	refresh_token_expired: "The refresh token has expired.",
	refresh_token_invalidated: "The refresh token was revoked or invalidated.",
	invalid_grant: "The authorization grant was rejected.",
	invalid_client: "The OAuth client was rejected.",
} as const;

const tokenFailure = async (
	response: Response,
	operation: "refresh" | "exchange",
): Promise<ProviderFailureError> => {
	// Only known codes become diagnostics; never retain the token endpoint body.
	const body = await response.json().catch(() => null);
	const candidate = body?.error?.code ?? body?.code ?? body?.error;
	const reason =
		typeof candidate === "string" && Object.hasOwn(oauthReasons, candidate)
			? (candidate as keyof typeof oauthReasons)
			: undefined;
	const status = response.status;
	const kind: ProviderFailureKind =
		status === 400 || status === 401 || status === 403
			? "auth"
			: status === 429
				? "rate_limit"
				: "provider";
	return new ProviderFailureError({
		provider: "openai",
		kind,
		status,
		code: `oauth_${operation}_${reason ?? "failed"}`,
		safeMessage: `OpenAI OAuth token ${operation} failed.`,
		detail:
			kind === "auth"
				? `${reason ? oauthReasons[reason] : "The token endpoint rejected the authorization request."} Sign in to OpenAI again.`
				: `The OAuth token endpoint could not complete the ${operation} request.`,
		retryable: status === 429 || status >= 500,
	});
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
		"exchange",
	);
};

export const refreshAccessToken = async (
	refreshToken: string,
	signal?: AbortSignal,
	options?: { timeoutMs?: number },
): Promise<OpenAiTokenResponse> => {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_OAUTH_REFRESH_TIMEOUT_MS;
	const timeoutController = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		timeoutController.abort(new Error("OAuth token refresh timed out"));
	}, timeoutMs);
	const effectiveSignal = signal
		? AbortSignal.any([signal, timeoutController.signal])
		: timeoutController.signal;
	try {
		return await requestToken(
			{
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: clientId(),
			},
			"refresh",
			effectiveSignal,
		);
	} catch (error) {
		if (timedOut) {
			throw new ProviderFailureError({
				provider: "openai",
				kind: "provider",
				code: "oauth_refresh_timeout",
				safeMessage: "OpenAI OAuth token refresh timed out.",
				detail: "The OAuth token endpoint did not respond before the timeout.",
				retryable: true,
			});
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
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

export const createOAuthSession = async (
	options: { callbackMode?: OAuthCallbackMode } = {},
): Promise<OAuthSession> => {
	const pkce = await generatePkce();
	const state = generateState();
	const port = oauthPort();
	const redirectUri = `http://localhost:${port}/auth/callback`;
	const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);
	const completeFromCode = (code: string) =>
		exchangeCodeForTokens(code, redirectUri, pkce);
	let completion: Promise<OpenAiTokenResponse> | null = null;
	const completeFromCodeOnce = (code: string): Promise<OpenAiTokenResponse> => {
		completion ??= completeFromCode(code);
		return completion;
	};
	const callbackMode = options.callbackMode ?? "server";

	if (callbackMode === "paste") {
		return {
			authUrl,
			redirectUri,
			waitForTokens: () =>
				Promise.reject(new Error("OAuth callback server is disabled")),
			completeFromInput: (input) =>
				completeFromCodeOnce(readOAuthCallbackCode(input, state)),
			stop: () => {},
		};
	}

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
		onCode: completeFromCodeOnce,
	});

	return {
		authUrl,
		redirectUri,
		waitForTokens: callbackServer.waitForResult,
		completeFromInput: (input) =>
			completeFromCodeOnce(readOAuthCallbackCode(input, state)),
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
