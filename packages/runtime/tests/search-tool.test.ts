import { describe, expect, test } from "bun:test";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createSearchTool } from "../src/tools/search";

const createToolContext = (): ToolContext => {
	const cache = new Map<string, unknown>();
	const deps: Record<string, unknown> = Object.create(null);
	return {
		deps,
		resolve: async <T>(key: DependencyKey<T>): Promise<T> => {
			if (cache.has(key.id)) {
				return cache.get(key.id) as T;
			}
			const value = await key.create();
			cache.set(key.id, value);
			return value;
		},
	};
};

describe("search tool", () => {
	test("ddg backend returns filtered results", async () => {
		const originalFetch = globalThis.fetch;
		const mockFetch = Object.assign(
			async (): Promise<Response> =>
				new Response(
					JSON.stringify({
						RelatedTopics: [
							{
								Text: "Example Domain - reference",
								FirstURL: "https://example.com",
							},
							{
								Text: "Other Domain - reference",
								FirstURL: "https://other.test",
							},
						],
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createSearchTool({
				defaultBackend: "ddg",
				braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
			});
			const result = await tool.executeRaw(
				JSON.stringify({
					query: "example",
					allowed_domains: ["example.com"],
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			expect(result.value).toEqual({
				query: "example",
				backend: "ddg",
				count: 1,
				results: [
					{
						title: "Example Domain",
						url: "https://example.com",
						snippet: "Example Domain - reference",
						source: "ddg",
					},
				],
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("brave backend requires API key env", async () => {
		const tool = createSearchTool({
			defaultBackend: "brave",
			braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
		});
		const prev = process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.BRAVE_SEARCH_API_KEY;
		try {
			const result = await tool.executeRaw(
				JSON.stringify({
					query: "example",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected result type");
			}
			expect(result.text).toContain("Missing BRAVE_SEARCH_API_KEY");
		} finally {
			if (prev === undefined) {
				delete process.env.BRAVE_SEARCH_API_KEY;
			} else {
				process.env.BRAVE_SEARCH_API_KEY = prev;
			}
		}
	});
});
