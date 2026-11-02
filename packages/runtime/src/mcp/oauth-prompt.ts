import type {
	UiConfirmRequestParams,
	UiConfirmResult,
	UiPromptRequestParams,
	UiPromptResult,
} from "@codelia/protocol";
import type { McpOAuthTokens } from "./auth-store";
import type { McpOAuthPromptConfig } from "./manager";
import { createMcpOAuthSession, type McpOAuthSession } from "./oauth";

export type McpOAuthPromptGateway = {
	runId?: string;
	supportsPrompt: boolean;
	waitForConfirmSupport: () => Promise<boolean>;
	confirm: (params: UiConfirmRequestParams) => Promise<UiConfirmResult | null>;
	prompt: (params: UiPromptRequestParams) => Promise<UiPromptResult | null>;
	shouldAutoOpenBrowser: () => boolean;
	openBrowser: (url: string) => void;
	log: (message: string) => void;
};

export const requestMcpOAuthTokens = async (
	gateway: McpOAuthPromptGateway,
	serverId: string,
	oauth: McpOAuthPromptConfig,
	errorMessage: string,
	signal?: AbortSignal,
): Promise<McpOAuthTokens | null> => {
	if (
		signal?.aborted ||
		!(await gateway.waitForConfirmSupport()) ||
		signal?.aborted
	) {
		return null;
	}
	if (!oauth.authorization_url || !oauth.token_url) {
		gateway.log(
			`mcp oauth skipped (${serverId}): missing authorization/token endpoint`,
		);
		return null;
	}

	let nextOAuth = { ...oauth };
	if (
		!nextOAuth.client_id &&
		!nextOAuth.registration_url &&
		gateway.supportsPrompt
	) {
		const prompt = await gateway.prompt({
			run_id: gateway.runId,
			title: `MCP OAuth (${serverId})`,
			message:
				"OAuth client_id is required. Enter client_id (empty value cancels).",
			multiline: false,
		});
		const clientId = prompt?.value?.trim();
		if (signal?.aborted || !clientId) {
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

	const shouldAutoOpen = gateway.shouldAutoOpenBrowser();
	const canPasteCallback = !shouldAutoOpen && gateway.supportsPrompt;
	let session: McpOAuthSession;
	try {
		session = await createMcpOAuthSession(
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
				signal,
			},
		);
	} catch (error) {
		if (signal?.aborted) return null;
		throw error;
	}
	try {
		if (signal?.aborted) return null;
		const lines = [
			`MCP server '${serverId}' requires OAuth.`,
			`Error: ${errorMessage}`,
			nextOAuth.authorization_url
				? `Authorization endpoint: ${nextOAuth.authorization_url}`
				: undefined,
			nextOAuth.token_url
				? `Token endpoint: ${nextOAuth.token_url}`
				: undefined,
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
		const confirm = await gateway.confirm({
			run_id: gateway.runId,
			title: `MCP OAuth (${serverId})`,
			message: lines.join("\n"),
			confirm_label: shouldAutoOpen ? "Open browser" : "I opened it",
			cancel_label: "Cancel",
			allow_remember: false,
			allow_reason: false,
		});
		if (signal?.aborted || !confirm?.ok) return null;
		if (shouldAutoOpen) {
			gateway.openBrowser(session.authUrl);
		}
		if (canPasteCallback) {
			const prompt = await gateway.prompt({
				run_id: gateway.runId,
				title: `MCP OAuth callback (${serverId})`,
				message:
					"After sign in completes, paste the full redirected URL from the browser address bar. You can also paste just code=...&state=....",
				multiline: false,
				secret: true,
			});
			const value = prompt?.value?.trim();
			if (signal?.aborted || !value) {
				return null;
			}
			return await session.completeFromInput(value);
		}
		return await session.waitForTokens();
	} catch (error) {
		if (signal?.aborted) return null;
		throw error;
	} finally {
		session.stop();
	}
};
