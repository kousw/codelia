import { describe, expect, test } from "bun:test";
import {
	type McpOAuthPromptGateway,
	requestMcpOAuthTokens,
} from "../src/mcp/oauth-prompt";

const createGateway = (
	overrides: Partial<McpOAuthPromptGateway> = {},
): McpOAuthPromptGateway => ({
	supportsPrompt: false,
	waitForConfirmSupport: async () => true,
	confirm: async () => null,
	prompt: async () => null,
	shouldAutoOpenBrowser: () => false,
	openBrowser: () => {},
	log: () => {},
	...overrides,
});

describe("requestMcpOAuthTokens", () => {
	test("stops before creating an OAuth session when confirm is unsupported", async () => {
		const result = await requestMcpOAuthTokens(
			createGateway({ waitForConfirmSupport: async () => false }),
			"example",
			{
				authorization_url: "https://example.test/authorize",
				token_url: "https://example.test/token",
			},
			"authorization required",
		);

		expect(result).toBeNull();
	});

	test("reports incomplete OAuth metadata without opening UI", async () => {
		const messages: string[] = [];
		let confirmed = false;
		const result = await requestMcpOAuthTokens(
			createGateway({
				confirm: async () => {
					confirmed = true;
					return null;
				},
				log: (message) => messages.push(message),
			}),
			"example",
			{},
			"authorization required",
		);

		expect(result).toBeNull();
		expect(confirmed).toBe(false);
		expect(messages).toEqual([
			"mcp oauth skipped (example): missing authorization/token endpoint",
		]);
	});

	test("cancels dynamic client registration during shutdown", async () => {
		const originalFetch = globalThis.fetch;
		const controller = new AbortController();
		let started = false;
		let confirmed = false;
		globalThis.fetch = ((_input, options) =>
			new Promise((_resolve, reject) => {
				started = true;
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			})) as typeof fetch;
		try {
			const pending = requestMcpOAuthTokens(
				createGateway({
					confirm: async () => {
						confirmed = true;
						return null;
					},
				}),
				"example",
				{
					authorization_url: "https://example.test/authorize",
					token_url: "https://example.test/token",
					registration_url: "https://example.test/register",
				},
				"authorization required",
				controller.signal,
			);
			for (let attempt = 0; attempt < 100 && !started; attempt++)
				await Bun.sleep(10);
			expect(started).toBe(true);
			controller.abort();
			expect(await pending).toBeNull();
			expect(confirmed).toBe(false);
		} finally {
			controller.abort();
			globalThis.fetch = originalFetch;
		}
	});
});
