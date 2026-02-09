import { createHash, randomBytes } from "node:crypto";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEFAULT_PORT = 1455;
const OAUTH_SCOPE = "openid profile email offline_access";

export const OPENAI_OAUTH_BASE_URL = "https://chatgpt.com/backend-api/codex";

const successHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>OpenAI OAuth Completed</title></head>
<body>
  <h2>OpenAI OAuth completed</h2>
  <p>You can close this window and return to Codelia.</p>
  <script>setTimeout(() => window.close(), 300);</script>
</body>
</html>`;

const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

const errorHtml = (message: string) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>OpenAI OAuth Failed</title></head>
<body>
  <h2>OpenAI OAuth failed</h2>
  <pre>${escapeHtml(message)}</pre>
</body>
</html>`;

export type OpenAiTokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in?: number;
	id_token?: string;
};

export type OpenAiOAuthTokens = {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	account_id?: string;
};

type Pkce = { verifier: string; challenge: string };

export type OAuthSession = {
	authUrl: string;
	waitForTokens: () => Promise<OpenAiTokenResponse>;
	stop: () => void;
	redirectUri: string;
};

const clientId = (): string => {
	const configured = process.env.CODELIA_OPENAI_OAUTH_CLIENT_ID?.trim();
	return configured && configured.length > 0 ? configured : DEFAULT_CLIENT_ID;
};

const oauthPort = (): number => {
	const value = process.env.CODELIA_OPENAI_OAUTH_PORT;
	if (!value) return DEFAULT_PORT;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
};

const base64UrlEncode = (buffer: Buffer): string =>
	buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

const buildPkce = (): Pkce => {
	const verifier = base64UrlEncode(randomBytes(48));
	const challenge = base64UrlEncode(
		createHash("sha256").update(verifier).digest(),
	);
	return { verifier, challenge };
};

const generateState = (): string => base64UrlEncode(randomBytes(32));

const buildAuthorizeUrl = (
	redirectUri: string,
	pkce: Pkce,
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

export const createOAuthRequest = (
	redirectUri: string,
): { state: string; codeVerifier: string; authUrl: string } => {
	const pkce = buildPkce();
	const state = generateState();
	const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);
	return {
		state,
		codeVerifier: pkce.verifier,
		authUrl,
	};
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
	codeVerifier: string,
): Promise<OpenAiTokenResponse> => {
	return requestToken(
		{
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri,
			client_id: clientId(),
			code_verifier: codeVerifier,
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
	const pkce = buildPkce();
	const state = generateState();
	const port = oauthPort();
	const redirectUri = `http://localhost:${port}/auth/callback`;
	const authUrl = buildAuthorizeUrl(redirectUri, pkce, state);

	let resolve: ((value: OpenAiTokenResponse) => void) | null = null;
	let reject: ((error: Error) => void) | null = null;
	let settled = false;
	const resolveOnce = (tokens: OpenAiTokenResponse) => {
		if (settled) return;
		settled = true;
		resolve?.(tokens);
	};
	const rejectOnce = (error: Error) => {
		if (settled) return;
		settled = true;
		reject?.(error);
	};
	const waitForTokens = () =>
		new Promise<OpenAiTokenResponse>((res, rej) => {
			resolve = res;
			reject = rej;
		});

	const server = Bun.serve({
		port,
		error: (error) => {
			console.error(`[openai-oauth] callback server error: ${String(error)}`);
			rejectOnce(new Error(String(error)));
			return new Response("server error", { status: 500 });
		},
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname !== "/auth/callback") {
				return new Response("not found", { status: 404 });
			}
			const code = url.searchParams.get("code");
			const returnedState = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			const errorDescription = url.searchParams.get("error_description") ?? "";

			if (error) {
				rejectOnce(new Error(errorDescription || error));
				return new Response(errorHtml(errorDescription || error), {
					headers: { "Content-Type": "text/html" },
				});
			}
			if (!code) {
				const message = "missing authorization code";
				rejectOnce(new Error(message));
				return new Response(errorHtml(message), {
					status: 400,
					headers: { "Content-Type": "text/html" },
				});
			}
			if (returnedState !== state) {
				const message = "invalid state";
				rejectOnce(new Error(message));
				return new Response(errorHtml(message), {
					status: 400,
					headers: { "Content-Type": "text/html" },
				});
			}

			try {
				const tokens = await exchangeCodeForTokens(
					code,
					redirectUri,
					pkce.verifier,
				);
				resolveOnce(tokens);
				return new Response(successHtml, {
					headers: { "Content-Type": "text/html" },
				});
			} catch (exchangeError) {
				const message =
					exchangeError instanceof Error
						? exchangeError.message
						: String(exchangeError);
				rejectOnce(new Error(message));
				return new Response(errorHtml(message), {
					status: 500,
					headers: { "Content-Type": "text/html" },
				});
			}
		},
	});

	return {
		authUrl,
		redirectUri,
		waitForTokens,
		stop: () => {
			rejectOnce(new Error("oauth session stopped"));
			server.stop();
		},
	};
};
