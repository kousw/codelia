import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
	generatePkce,
	generateState,
	readPositiveIntEnv,
	startOAuthCallbackServer,
} from "../src/auth/oauth-utils";

const reservePort = async (): Promise<number> => {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => resolve());
		server.on("error", reject);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("failed to reserve port");
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
};

const restoreEnv: Array<[string, string | undefined]> = [];
const setEnv = (key: string, value?: string) => {
	restoreEnv.push([key, process.env[key]]);
	if (value === undefined) {
		delete process.env[key];
		return;
	}
	process.env[key] = value;
};

afterEach(() => {
	for (const [key, value] of restoreEnv.splice(0).reverse()) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("oauth utils", () => {
	test("generatePkce and generateState return non-empty values", async () => {
		const pkce = await generatePkce();
		const state = generateState();
		expect(pkce.verifier.length).toBeGreaterThan(20);
		expect(pkce.challenge.length).toBeGreaterThan(20);
		expect(state.length).toBeGreaterThan(10);
	});

	test("readPositiveIntEnv falls back on invalid values", () => {
		setEnv("CODELIA_TEST_POSITIVE", "42");
		expect(readPositiveIntEnv("CODELIA_TEST_POSITIVE", 10)).toBe(42);
		setEnv("CODELIA_TEST_POSITIVE", "0");
		expect(readPositiveIntEnv("CODELIA_TEST_POSITIVE", 10)).toBe(10);
		setEnv("CODELIA_TEST_POSITIVE", "abc");
		expect(readPositiveIntEnv("CODELIA_TEST_POSITIVE", 10)).toBe(10);
	});

	test("callback server resolves on valid code and state", async () => {
		const port = await reservePort();
		const session = startOAuthCallbackServer<string>({
			port,
			callbackPath: "/auth/callback",
			cancelPath: "/cancel",
			expectedState: "state-ok",
			successHtml: "<html>ok</html>",
			errorHtml: (message) => `<html>${message}</html>`,
			onCode: async (code) => `token:${code}`,
		});
		try {
			const waitForResult = session.waitForResult();
			const response = await fetch(
				`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-ok`,
			);
			expect(response.status).toBe(200);
			await expect(waitForResult).resolves.toBe("token:abc");
		} finally {
			session.stop();
		}
	});

	test("callback server rejects invalid state", async () => {
		const port = await reservePort();
		const session = startOAuthCallbackServer<string>({
			port,
			callbackPath: "/auth/callback",
			cancelPath: "/cancel",
			expectedState: "state-ok",
			successHtml: "<html>ok</html>",
			errorHtml: (message) => `<html>${message}</html>`,
			invalidStateMessage: "invalid oauth state",
			onCode: async (code) => `token:${code}`,
		});
		try {
			const waitForResult = session.waitForResult();
			void waitForResult.catch(() => undefined);
			const response = await fetch(
				`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-bad`,
			);
			expect(response.status).toBe(400);
			await expect(waitForResult).rejects.toThrow("invalid oauth state");
		} finally {
			session.stop();
		}
	});

	test("callback server rejects when timeout is reached", async () => {
		const port = await reservePort();
		const session = startOAuthCallbackServer<string>({
			port,
			callbackPath: "/auth/callback",
			cancelPath: "/cancel",
			expectedState: "state-ok",
			successHtml: "<html>ok</html>",
			errorHtml: (message) => `<html>${message}</html>`,
			timeoutMs: 30,
			timeoutMessage: "timed out",
			onCode: async (code) => `token:${code}`,
		});
		try {
			await expect(session.waitForResult()).rejects.toThrow("timed out");
		} finally {
			session.stop();
		}
	});
});
