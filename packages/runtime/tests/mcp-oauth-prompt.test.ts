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
});
