import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
	createOAuthSession,
	resolveBrowserLaunch,
} from "../src/auth/openai-oauth";

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

describe("openai oauth browser launch", () => {
	test("uses open on darwin", () => {
		const url = "https://example.com/auth?foo=bar";
		const launch = resolveBrowserLaunch("darwin", url);
		expect(launch.command).toBe("open");
		expect(launch.args).toEqual([url]);
		expect(launch.options.windowsHide).toBeUndefined();
	});

	test("uses xdg-open on linux", () => {
		const url = "https://example.com/auth?foo=bar";
		const launch = resolveBrowserLaunch("linux", url);
		expect(launch.command).toBe("xdg-open");
		expect(launch.args).toEqual([url]);
		expect(launch.options.windowsHide).toBeUndefined();
	});

	test("uses rundll32 on win32 and preserves query params", () => {
		const url =
			"https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=abc";
		const launch = resolveBrowserLaunch("win32", url);
		expect(launch.command).toBe("rundll32");
		expect(launch.args[0]).toBe("url.dll,FileProtocolHandler");
		expect(launch.args[1]).toBe(url);
		expect(launch.options.windowsHide).toBe(true);
		expect(launch.options.shell).toBeUndefined();
	});

	test("paste callback mode does not bind localhost and exchanges code once", async () => {
		const busy = await reserveBusyPort();
		setEnv("CODELIA_OPENAI_OAUTH_PORT", String(busy.port));
		let tokenExchangeCalls = 0;
		globalThis.fetch = Object.assign(
			async (input: RequestInfo | URL): Promise<Response> => {
				tokenExchangeCalls += 1;
				expect(String(input)).toBe("https://auth.openai.com/oauth/token");
				return Response.json({
					access_token: "access-token-123",
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		try {
			const session = await createOAuthSession({ callbackMode: "paste" });
			const state = new URL(session.authUrl).searchParams.get("state");
			expect(state).toBeTruthy();
			await expect(session.waitForTokens()).rejects.toThrow(
				"OAuth callback server is disabled",
			);
			const tokens = await session.completeFromInput(
				`http://localhost:${busy.port}/auth/callback?code=code-ok&state=${state}`,
			);
			expect(tokens.access_token).toBe("access-token-123");
			expect(tokenExchangeCalls).toBe(1);
		} finally {
			await busy.close();
		}
	});

	test("server callback and pasted callback share one token exchange", async () => {
		const port = await reserveFreePort();
		setEnv("CODELIA_OPENAI_OAUTH_PORT", String(port));
		let tokenExchangeCalls = 0;
		globalThis.fetch = Object.assign(
			async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url = String(input);
				if (url.startsWith(`http://127.0.0.1:${port}/auth/callback?`)) {
					return originalFetch(input, init);
				}
				tokenExchangeCalls += 1;
				expect(url).toBe("https://auth.openai.com/oauth/token");
				return Response.json({
					access_token: "access-token-123",
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				});
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;

		const session = await createOAuthSession();
		const state = new URL(session.authUrl).searchParams.get("state");
		expect(state).toBeTruthy();
		const callbackUrl = `http://127.0.0.1:${port}/auth/callback?code=code-ok&state=${state}`;
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
