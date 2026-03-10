import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAiDeviceCodeSession } from "../src/auth/openai-device-code";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("openai device code", () => {
	test("creates a device-code session and exchanges tokens after polling", async () => {
		let pollCalls = 0;
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/api/accounts/deviceauth/usercode")) {
				expect(init?.method).toBe("POST");
				return Response.json({
					device_auth_id: "device-auth-123",
					user_code: "CODE-12345",
					interval: "0",
				});
			}
			if (url.endsWith("/api/accounts/deviceauth/token")) {
				pollCalls += 1;
				if (pollCalls === 1) {
					return new Response("pending", { status: 404 });
				}
				return Response.json({
					authorization_code: "auth-code-123",
					code_challenge: "challenge-123",
					code_verifier: "verifier-123",
				});
			}
			if (url.endsWith("/oauth/token")) {
				expect(init?.method).toBe("POST");
				const body = String(init?.body ?? "");
				expect(body).toContain("grant_type=authorization_code");
				expect(body).toContain("code=auth-code-123");
				expect(body).toContain(
					"redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
				);
				expect(body).toContain("code_verifier=verifier-123");
				return Response.json({
					access_token: "access-token-123",
					refresh_token: "refresh-token-123",
					expires_in: 3600,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;

		const session = await createOpenAiDeviceCodeSession();
		expect(session.verificationUrl).toBe(
			"https://auth.openai.com/codex/device",
		);
		expect(session.userCode).toBe("CODE-12345");

		const tokens = await session.complete();
		expect(tokens.access_token).toBe("access-token-123");
		expect(tokens.refresh_token).toBe("refresh-token-123");
		expect(pollCalls).toBe(2);
	});

	test("surfaces when device code login is unavailable", async () => {
		globalThis.fetch = (async (): Promise<Response> => {
			return new Response("missing", { status: 404 });
		}) as unknown as typeof fetch;

		await expect(createOpenAiDeviceCodeSession()).rejects.toThrow(
			"OpenAI device code login is not enabled for this client",
		);
	});
});
