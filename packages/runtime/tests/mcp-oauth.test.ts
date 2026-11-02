import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { requestMcpOAuthTokens } from "../src/agent-factory";
import { createMcpOAuthSession } from "../src/mcp/oauth";
import { RuntimeState } from "../src/runtime-state";

const originalFetch = globalThis.fetch;
const restoreEnv: Array<[string, string | undefined]> = [];

const setEnv = (key: string, value?: string) => {
	restoreEnv.push([key, process.env[key]]);
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
};

const reserveBusyPort = async (): Promise<{
	port: number;
	close: () => Promise<void>;
}> => {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => resolve());
		server.on("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("failed to bind test port");
	}
	return {
		port: address.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};

const reserveFreePort = async (): Promise<number> => {
	const busy = await reserveBusyPort();
	const { port } = busy;
	await busy.close();
	return port;
};

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, value] of restoreEnv.splice(0).reverse()) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("mcp oauth", () => {
	test("aborting immediately after session creation releases the callback port", async () => {
		const port = await reserveFreePort();
		setEnv("CODELIA_MCP_OAUTH_PORT", String(port));
		const controller = new AbortController();
		const session = await createMcpOAuthSession(
			{
				server_id: "example",
				authorization_url: "https://example.test/authorize",
				token_url: "https://example.test/token",
				client_id: "test-client",
			},
			{ signal: controller.signal },
		);
		try {
			controller.abort();
			await expect(session.waitForTokens()).rejects.toThrow("oauth cancelled");
			let rebound = false;
			for (let attempt = 0; attempt < 100 && !rebound; attempt++) {
				const probe = createServer();
				rebound = await new Promise<boolean>((resolve) => {
					probe.once("error", () => resolve(false));
					probe.listen(port, "127.0.0.1", () =>
						probe.close(() => resolve(true)),
					);
				});
				if (!rebound) await Bun.sleep(10);
			}
			expect(rebound).toBe(true);
		} finally {
			controller.abort();
			session.stop();
		}
	});

	test("shutdown cancels a pending client-id prompt", async () => {
		const state = new RuntimeState();
		state.setUiCapabilities({ supports_confirm: true, supports_prompt: true });
		const controller = new AbortController();
		const originalWrite = process.stdout.write;
		let requestId: string | undefined;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			const message = JSON.parse(String(chunk));
			if (message.method === "ui.prompt.request") requestId = message.id;
			return true;
		}) as typeof process.stdout.write;
		try {
			const pending = requestMcpOAuthTokens(
				state,
				"example",
				{
					authorization_url: "https://example.test/authorize",
					token_url: "https://example.test/token",
				},
				"authorization required",
				controller.signal,
			);
			for (let attempt = 0; attempt < 100 && !requestId; attempt++)
				await Bun.sleep(10);
			expect(requestId).toBeDefined();
			if (!requestId) throw new Error("missing OAuth prompt request");
			const pendingRequestId = requestId;
			controller.abort();
			expect(await pending).toBeNull();
			expect(
				state.resolveUiResponse({
					jsonrpc: "2.0",
					id: pendingRequestId,
					result: { value: "late" },
				}),
			).toBe(false);
		} finally {
			controller.abort();
			process.stdout.write = originalWrite;
		}
	});

	test("shutdown cancels a pending UI confirmation and closes the callback listener", async () => {
		const port = await reserveFreePort();
		setEnv("CODELIA_MCP_OAUTH_PORT", String(port));
		const state = new RuntimeState();
		state.setUiCapabilities({ supports_confirm: true });
		const controller = new AbortController();
		const originalWrite = process.stdout.write;
		let requestId: string | undefined;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			const message = JSON.parse(String(chunk));
			if (message.method === "ui.confirm.request") requestId = message.id;
			return true;
		}) as typeof process.stdout.write;
		try {
			const pending = requestMcpOAuthTokens(
				state,
				"example",
				{
					authorization_url: "https://example.test/authorize",
					token_url: "https://example.test/token",
					client_id: "test-client",
				},
				"authorization required",
				controller.signal,
			);
			for (let attempt = 0; attempt < 100 && !requestId; attempt++)
				await Bun.sleep(10);
			expect(requestId).toBeDefined();
			if (!requestId) throw new Error("missing OAuth confirmation request");
			const pendingRequestId = requestId;
			const response = await originalFetch(`http://127.0.0.1:${port}/unknown`, {
				headers: { connection: "close" },
			});
			expect(response.status).toBe(404);
			controller.abort();
			expect(await pending).toBeNull();
			expect(
				state.resolveUiResponse({
					jsonrpc: "2.0",
					id: pendingRequestId,
					result: { ok: true },
				}),
			).toBe(false);
			let rebound = false;
			for (let attempt = 0; attempt < 100 && !rebound; attempt++) {
				const probe = createServer();
				rebound = await new Promise<boolean>((resolve) => {
					probe.once("error", () => resolve(false));
					probe.listen(port, "127.0.0.1", () =>
						probe.close(() => resolve(true)),
					);
				});
				if (!rebound) await Bun.sleep(10);
			}
			expect(rebound).toBe(true);
		} finally {
			controller.abort();
			process.stdout.write = originalWrite;
		}
	});

	test("paste callback mode does not bind localhost and exchanges code once", async () => {
		const busy = await reserveBusyPort();
		setEnv("CODELIA_MCP_OAUTH_PORT", String(busy.port));
		let tokenExchangeCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL): Promise<Response> => {
				tokenExchangeCalls += 1;
				expect(String(input)).toBe("https://example.com/oauth/token");
				return Response.json({
					access_token: "access-token-123",
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		try {
			const session = await createMcpOAuthSession(
				{
					server_id: "example",
					authorization_url: "https://example.com/oauth/authorize",
					token_url: "https://example.com/oauth/token",
					client_id: "client-id",
				},
				{ callbackMode: "paste" },
			);
			const state = new URL(session.authUrl).searchParams.get("state");
			expect(state).toBeTruthy();
			await expect(session.waitForTokens()).rejects.toThrow(
				"OAuth callback server is disabled",
			);
			const tokens = await session.completeFromInput(
				`http://localhost:${busy.port}/mcp/oauth/callback?code=code-ok&state=${state}`,
			);
			expect(tokens.access_token).toBe("access-token-123");
			expect(tokenExchangeCalls).toBe(1);
		} finally {
			await busy.close();
		}
	});

	test("server callback and pasted callback share one token exchange", async () => {
		const port = await reserveFreePort();
		setEnv("CODELIA_MCP_OAUTH_PORT", String(port));
		let tokenExchangeCalls = 0;
		globalThis.fetch = Object.assign(
			async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url = String(input);
				if (url.startsWith(`http://127.0.0.1:${port}/mcp/oauth/callback?`)) {
					return originalFetch(input, init);
				}
				tokenExchangeCalls += 1;
				expect(url).toBe("https://example.com/oauth/token");
				return Response.json({
					access_token: "access-token-123",
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const session = await createMcpOAuthSession({
			server_id: "example",
			authorization_url: "https://example.com/oauth/authorize",
			token_url: "https://example.com/oauth/token",
			client_id: "client-id",
		});
		const state = new URL(session.authUrl).searchParams.get("state");
		expect(state).toBeTruthy();
		const callbackUrl = `http://127.0.0.1:${port}/mcp/oauth/callback?code=code-ok&state=${state}`;
		const waitForTokens = session.waitForTokens();
		const callbackResponse = await fetch(callbackUrl);
		expect(callbackResponse.status).toBe(200);
		const pastedTokens = await session.completeFromInput(callbackUrl);
		const waitedTokens = await waitForTokens;
		expect(pastedTokens.access_token).toBe("access-token-123");
		expect(waitedTokens.access_token).toBe("access-token-123");
		expect(tokenExchangeCalls).toBe(1);
		session.stop();
	});
});
