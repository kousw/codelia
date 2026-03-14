import { describe, expect, test } from "bun:test";
import type { DependencyKey, ToolContext } from "@codelia/core";
import { createWebfetchTool } from "../src/tools/webfetch";

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

describe("webfetch tool", () => {
	test("fetches HTML and converts it to markdown", async () => {
		const originalFetch = globalThis.fetch;
		const mockFetch = Object.assign(
			async (): Promise<Response> =>
				new Response(
					[
						"<html>",
						"<head><title>Example Page</title></head>",
						"<body>",
						"<h1>Hello</h1>",
						"<p>Visit <a href=\"https://example.com/docs\">Docs</a>.</p>",
						"</body>",
						"</html>",
					].join(""),
					{
						status: 200,
						headers: { "content-type": "text/html; charset=utf-8" },
					},
				),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com",
					output_format: "markdown",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				status: number;
				output_format: string;
				title: string | null;
				content: string;
				truncated: boolean;
			};
			expect(value.status).toBe(200);
			expect(value.output_format).toBe("markdown");
			expect(value.title).toBe("Example Page");
			expect(value.content).toContain("# Hello");
			expect(value.content).toContain("[Docs](https://example.com/docs)");
			expect(value.truncated).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("decodes text using the declared charset", async () => {
		const originalFetch = globalThis.fetch;
		const latin1Cafe = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
		const mockFetch = Object.assign(
			async (): Promise<Response> =>
				new Response(latin1Cafe, {
					status: 200,
					headers: { "content-type": "text/plain; charset=iso-8859-1" },
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com/latin1.txt",
					output_format: "text",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as { content: string };
			expect(value.content).toBe("café");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("truncates oversized responses to the requested byte limit", async () => {
		const originalFetch = globalThis.fetch;
		const mockFetch = Object.assign(
			async (): Promise<Response> =>
				new Response("x".repeat(200), {
					status: 200,
					headers: { "content-type": "text/plain; charset=utf-8" },
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com/large.txt",
					output_format: "text",
					max_bytes: 32,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("json");
			if (result.type !== "json") {
				throw new Error("unexpected result type");
			}
			const value = result.value as {
				content: string;
				truncated: boolean;
			};
			expect(value.truncated).toBe(true);
			expect(Buffer.byteLength(value.content, "utf8")).toBeLessThanOrEqual(32);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rejects binary content-types instead of returning mojibake", async () => {
		const originalFetch = globalThis.fetch;
		const pngBytes = Buffer.from(
			"89504E470D0A1A0A0000000D49484452",
			"hex",
		);
		const mockFetch = Object.assign(
			async (): Promise<Response> =>
				new Response(pngBytes, {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com/logo.png",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected result type");
			}
			expect(result.text).toContain("Unsupported content-type for webfetch");
			expect(result.text).toContain("image/png");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("classifies timeout failures", async () => {
		const originalFetch = globalThis.fetch;
		const abortError = new Error("request aborted");
		abortError.name = "AbortError";
		const mockFetch = Object.assign(
			async (): Promise<Response> => {
				throw abortError;
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com",
					timeout_ms: 321,
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected result type");
			}
			expect(result.text).toContain("Error fetching URL [timeout]");
			expect(result.text).toContain("timed out after 321ms");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("classifies tls failures from local issuer certificate errors", async () => {
		const originalFetch = globalThis.fetch;
		const tlsError = new TypeError("fetch failed");
		Object.assign(tlsError, {
			cause: { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
		});
		const mockFetch = Object.assign(
			async (): Promise<Response> => {
				throw tlsError;
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://example.com",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected result type");
			}
			expect(result.text).toContain("Error fetching URL [tls_error]");
			expect(result.text).toContain("certificate validation failed");
			expect(result.text).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("classifies dns failures", async () => {
		const originalFetch = globalThis.fetch;
		const dnsError = new TypeError("fetch failed");
		Object.assign(dnsError, {
			cause: { code: "ENOTFOUND" },
		});
		const mockFetch = Object.assign(
			async (): Promise<Response> => {
				throw dnsError;
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		globalThis.fetch = mockFetch;
		try {
			const tool = createWebfetchTool();
			const result = await tool.executeRaw(
				JSON.stringify({
					url: "https://missing.example.test",
				}),
				createToolContext(),
			);
			expect(result.type).toBe("text");
			if (result.type !== "text") {
				throw new Error("unexpected result type");
			}
			expect(result.text).toContain("Error fetching URL [dns_error]");
			expect(result.text).toContain("ENOTFOUND");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
