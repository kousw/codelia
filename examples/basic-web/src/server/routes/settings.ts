import { Hono } from "hono";
import { z } from "zod";
import type { AgentPool } from "../agent/agent-pool";
import {
	createOAuthRequest,
	createOAuthSession,
	exchangeCodeForTokens,
	extractAccountId,
	type OAuthSession,
} from "../config/openai-oauth";
import type { SettingsStoreLike } from "../settings/settings-store";

const settingsPatchSchema = z.object({
	provider: z.enum(["openai", "anthropic"]).optional(),
	model: z.string().optional(),
	reasoning: z.enum(["low", "medium", "high"]).optional(),
	clear_reasoning: z.boolean().optional(),
	openai_api_key: z.string().optional(),
	clear_openai_oauth: z.boolean().optional(),
	anthropic_api_key: z.string().optional(),
	clear_openai_api_key: z.boolean().optional(),
	clear_anthropic_api_key: z.boolean().optional(),
});

const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

export const createSettingsRoutes = (
	settingsStore: SettingsStoreLike,
	pool: AgentPool,
) => {
	const app = new Hono();
	let activeOAuthSession: OAuthSession | null = null;
	const publicBaseUrl =
		process.env.CODELIA_OPENAI_OAUTH_PUBLIC_BASE_URL?.trim();

	app.get("/", async (c) => {
		const settings = await settingsStore.getPublicSettings();
		return c.json(settings);
	});

	app.patch("/", async (c) => {
		const body = await c.req.json();
		const parsed = settingsPatchSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: "Invalid input", details: parsed.error }, 400);
		}
		const next = await settingsStore.patchSettings(parsed.data);
		pool.invalidateAll("settings updated");
		return c.json(next);
	});

	app.get("/openai/oauth/start", async (c) => {
		if (publicBaseUrl) {
			const base = publicBaseUrl.replace(/\/+$/, "");
			const redirectUri = `${base}/api/settings/openai/oauth/callback`;
			const request = createOAuthRequest(redirectUri);
			await settingsStore.saveOAuthState({
				provider: "openai",
				state: request.state,
				code_verifier: request.codeVerifier,
				redirect_uri: redirectUri,
				expires_at: Date.now() + 10 * 60 * 1000,
			});
			c.header("Cache-Control", "no-store");
			return c.redirect(request.authUrl, 302);
		}

		if (activeOAuthSession) {
			activeOAuthSession.stop();
			activeOAuthSession = null;
		}

		const session = await createOAuthSession();
		activeOAuthSession = session;

		void session
			.waitForTokens()
			.then(async (tokens) => {
				const accountId = extractAccountId(tokens);
				await settingsStore.saveOpenAiOAuth({
					access_token: tokens.access_token,
					refresh_token: tokens.refresh_token,
					expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
					...(accountId ? { account_id: accountId } : {}),
				});
				pool.invalidateAll("openai oauth updated");
			})
			.catch((oauthError) => {
				const message =
					oauthError instanceof Error ? oauthError.message : String(oauthError);
				console.error(`[openai-oauth] flow failed: ${message}`);
			})
			.finally(() => {
				session.stop();
				if (activeOAuthSession === session) {
					activeOAuthSession = null;
				}
			});

		c.header("Cache-Control", "no-store");
		return c.redirect(session.authUrl, 302);
	});

	app.get("/openai/oauth/callback", async (c) => {
		const code = c.req.query("code");
		const state = c.req.query("state");
		const error = c.req.query("error");
		const errorDescription = c.req.query("error_description");
		const html = (body: string, status = 200) =>
			new Response(
				`<!doctype html><html><head><meta charset="utf-8" /><title>OpenAI OAuth</title></head><body>${body}</body></html>`,
				{
					status,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				},
			);
		if (error) {
			return html(
				`<h2>OpenAI OAuth failed</h2><pre>${escapeHtml(errorDescription ?? error)}</pre>`,
				400,
			);
		}
		if (!code || !state) {
			return html(
				"<h2>OpenAI OAuth failed</h2><pre>missing code/state</pre>",
				400,
			);
		}
		const consumed = await settingsStore.consumeOAuthState("openai", state);
		if (!consumed) {
			return html(
				"<h2>OpenAI OAuth failed</h2><pre>invalid or expired state</pre>",
				400,
			);
		}
		try {
			const tokens = await exchangeCodeForTokens(
				code,
				consumed.redirect_uri,
				consumed.code_verifier,
			);
			const accountId = extractAccountId(tokens);
			await settingsStore.saveOpenAiOAuth({
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				...(accountId ? { account_id: accountId } : {}),
			});
			pool.invalidateAll("openai oauth updated");
			return html(
				"<h2>OpenAI OAuth completed</h2><p>You can close this window and return to Codelia.</p><script>setTimeout(() => window.close(), 300);</script>",
			);
		} catch (oauthError) {
			const message =
				oauthError instanceof Error ? oauthError.message : String(oauthError);
			return html(
				`<h2>OpenAI OAuth failed</h2><pre>${escapeHtml(message)}</pre>`,
				500,
			);
		}
	});

	return app;
};
