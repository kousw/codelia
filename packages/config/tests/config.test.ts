import { describe, expect, test } from "bun:test";
import { CONFIG_VERSION, ConfigRegistry, parseConfig } from "../src/index";

describe("@codelia/config", () => {
	test("parseConfig returns model fields", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				model: {
					provider: "openai",
					name: "gpt-5.2-codex",
					reasoning: "medium",
					verbosity: "low",
				},
			},
			"test.json",
		);

		expect(parsed).toEqual({
			version: CONFIG_VERSION,
			model: {
				provider: "openai",
				name: "gpt-5.2-codex",
				reasoning: "medium",
				verbosity: "low",
			},
		});
	});

	test("parseConfig returns permissions rules", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				permissions: {
					allow: [
						{ tool: "read" },
						{ tool: "bash", command: "rg" },
						{ tool: "skill_load", skill_name: "repo-review" },
					],
					deny: [{ tool: "bash", command_glob: "rm *" }],
				},
			},
			"test.json",
		);

		expect(parsed.permissions).toEqual({
			allow: [
				{ tool: "read" },
				{ tool: "bash", command: "rg" },
				{ tool: "skill_load", skill_name: "repo-review" },
			],
			deny: [{ tool: "bash", command_glob: "rm *" }],
		});
	});

	test("parseConfig ignores invalid skill_name in permission rules", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				permissions: {
					allow: [{ tool: "skill_load", skill_name: "Repo Review" }],
				},
			},
			"test.json",
		);

		expect(parsed.permissions?.allow).toEqual([{ tool: "skill_load" }]);
	});

	test("parseConfig returns mcp server config", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				mcp: {
					servers: {
						remote: {
							transport: "http",
							url: "https://example.com/mcp",
							headers: { "X-Workspace": "codelia" },
							request_timeout_ms: 45000,
							oauth: {
								authorization_url: "https://example.com/oauth/authorize",
								token_url: "https://example.com/oauth/token",
								registration_url: "https://example.com/oauth/register",
								client_id: "codelia-dev",
							},
						},
						local: {
							transport: "stdio",
							command: "npx",
							args: ["-y", "@modelcontextprotocol/server-filesystem"],
						},
					},
				},
			},
			"test.json",
		);

		expect(parsed.mcp).toEqual({
			servers: {
				remote: {
					transport: "http",
					url: "https://example.com/mcp",
					headers: { "X-Workspace": "codelia" },
					request_timeout_ms: 45000,
					oauth: {
						authorization_url: "https://example.com/oauth/authorize",
						token_url: "https://example.com/oauth/token",
						registration_url: "https://example.com/oauth/register",
						client_id: "codelia-dev",
					},
				},
				local: {
					transport: "stdio",
					command: "npx",
					args: ["-y", "@modelcontextprotocol/server-filesystem"],
				},
			},
		});
	});

	test("parseConfig ignores MCP servers with invalid server id", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				mcp: {
					servers: {
						remote_1: {
							transport: "http",
							url: "https://example.com/mcp",
						},
						"invalid id": {
							transport: "http",
							url: "https://example.com/invalid-space",
						},
						"": {
							transport: "stdio",
							command: "npx",
						},
					},
				},
			},
			"test.json",
		);

		expect(parsed.mcp).toEqual({
			servers: {
				remote_1: {
					transport: "http",
					url: "https://example.com/mcp",
				},
			},
		});
	});

	test("parseConfig ignores MCP servers with id longer than 64 chars", () => {
		const longId = "a".repeat(65);
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				mcp: {
					servers: {
						[longId]: {
							transport: "http",
							url: "https://example.com/mcp",
						},
						ok: {
							transport: "stdio",
							command: "npx",
						},
					},
				},
			},
			"test.json",
		);

		expect(parsed.mcp).toEqual({
			servers: {
				ok: {
					transport: "stdio",
					command: "npx",
				},
			},
		});
	});

	test("parseConfig rejects non-object config values", () => {
		const cases: Array<{ label: string; value: unknown }> = [
			{ label: "null", value: null },
			{ label: "array", value: [] },
			{ label: "string", value: "nope" },
		];

		for (const testCase of cases) {
			expect(() => parseConfig(testCase.value, "test.json")).toThrow(
				"config must be an object",
			);
		}
	});

	test("parseConfig throws on unsupported version", () => {
		expect(() => parseConfig({ version: 2 }, "test.json")).toThrow(
			"unsupported version",
		);
	});

	test("parseConfig ignores non-string model fields", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				model: {
					provider: 123,
					name: true,
					reasoning: { mode: "high" },
					verbosity: ["medium"],
				},
			},
			"test.json",
		);

		expect(parsed).toEqual({
			version: CONFIG_VERSION,
			model: {
				provider: undefined,
				name: undefined,
				reasoning: undefined,
				verbosity: undefined,
			},
		});
	});

	test("parseConfig returns skills config", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				skills: {
					enabled: false,
					initial: {
						maxEntries: 100,
						maxBytes: 16 * 1024,
					},
					search: {
						defaultLimit: 5,
						maxLimit: 25,
					},
				},
			},
			"test.json",
		);

		expect(parsed.skills).toEqual({
			enabled: false,
			initial: {
				maxEntries: 100,
				maxBytes: 16 * 1024,
			},
			search: {
				defaultLimit: 5,
				maxLimit: 25,
			},
		});
	});

	test("parseConfig ignores invalid skills values", () => {
		const parsed = parseConfig(
			{
				version: CONFIG_VERSION,
				skills: {
					enabled: "yes",
					initial: {
						maxEntries: -1,
						maxBytes: 0,
					},
					search: {
						defaultLimit: 0,
						maxLimit: 1.5,
					},
				},
			},
			"test.json",
		);

		expect(parsed.skills).toBeUndefined();
	});

	test("ConfigRegistry merges defaults with overrides", () => {
		const registry = new ConfigRegistry();
		registry.registerDefaults({
			model: {
				provider: "openai",
				name: "default",
				reasoning: "low",
				verbosity: "medium",
			},
			permissions: {
				allow: [{ tool: "read" }],
			},
			mcp: {
				servers: {
					defaultServer: {
						transport: "http",
						url: "https://default.example.com/mcp",
						enabled: true,
					},
				},
			},
			skills: {
				enabled: true,
				initial: {
					maxEntries: 200,
				},
				search: {
					defaultLimit: 8,
				},
			},
		});

		const effective = registry.resolve([
			{
				model: {
					name: "override",
					verbosity: "high",
				},
				permissions: {
					allow: [{ tool: "bash", command: "rg" }],
					deny: [{ tool: "bash", command: "rm" }],
				},
				mcp: {
					servers: {
						defaultServer: {
							transport: "http",
							url: "https://project.example.com/mcp",
							enabled: false,
						},
						localServer: {
							transport: "stdio",
							command: "npx",
						},
					},
				},
				skills: {
					initial: {
						maxBytes: 65536,
					},
					search: {
						maxLimit: 40,
					},
				},
			},
		]);

		expect(effective.model).toEqual({
			provider: "openai",
			name: "override",
			reasoning: "low",
			verbosity: "high",
		});
		expect(effective.permissions).toEqual({
			allow: [{ tool: "read" }, { tool: "bash", command: "rg" }],
			deny: [{ tool: "bash", command: "rm" }],
		});
		expect(effective.mcp).toEqual({
			servers: {
				defaultServer: {
					transport: "http",
					url: "https://project.example.com/mcp",
					enabled: false,
				},
				localServer: {
					transport: "stdio",
					command: "npx",
				},
			},
		});
		expect(effective.skills).toEqual({
			enabled: true,
			initial: {
				maxEntries: 200,
				maxBytes: 65536,
			},
			search: {
				defaultLimit: 8,
				maxLimit: 40,
			},
		});
	});
});
