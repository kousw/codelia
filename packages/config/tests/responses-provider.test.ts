import { describe, expect, test } from "bun:test";
import { ConfigRegistry, parseConfig } from "../src";

const endpoint = {
	type: "responses",
	base_url: "http://localhost:8080/v1/",
	models: {
		model: {
			context_window: 131072,
			supports_tools: true,
			supports_reasoning: true,
			reasoning_levels: ["low", "medium", "high"],
		},
	},
};

describe("named Responses providers", () => {
	test("registers independent endpoints and replaces a whole project endpoint", () => {
		const global = parseConfig(
			{ version: 1, providers: { home: endpoint, local: endpoint } },
			"global",
		);
		const project = parseConfig(
			{
				version: 1,
				providers: {
					home: {
						...endpoint,
						base_url: "https://example.test/v1",
						models: { other: { context_window: 32768 } },
					},
				},
			},
			"project",
		);
		const config = new ConfigRegistry().resolve([global, project]);
		expect(config.providers?.local.base_url).toBe("http://localhost:8080/v1");
		expect(Object.keys(config.providers?.home.models ?? {})).toEqual(["other"]);
	});

	test("rejects invalid URLs, builtin names, secrets and malformed model limits", () => {
		for (const providers of [
			{ openai: endpoint },
			{ constructor: endpoint },
			{ home: { ...endpoint, base_url: "ftp://example.test" } },
			{
				home: {
					...endpoint,
					base_url: "https://user:password@example.test/v1",
				},
			},
			{ home: { ...endpoint, api_key: "never-in-config" } },
			{ home: { ...endpoint, api_key_env: "bad env" } },
			{ home: { ...endpoint, models: {} } },
			{
				home: {
					...endpoint,
					models: { model: { context_window: 100, max_output_tokens: 101 } },
				},
			},
			{
				home: {
					...endpoint,
					models: {
						model: { context_window: 100, reasoning_levels: ["unknown"] },
					},
				},
			},
			{ home: { ...endpoint, retry: { max_retries: -1 } } },
			{ home: { ...endpoint, timeout_ms: 0 } },
		])
			expect(() => parseConfig({ version: 1, providers }, "test")).toThrow(
				"providers",
			);
	});
});
