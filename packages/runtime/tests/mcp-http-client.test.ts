import { describe, expect, test } from "bun:test";
import { HttpMcpClient } from "../src/mcp/client";

describe("HttpMcpClient oauth refresh", () => {
	test("retries once with refreshed bearer token on 401", async () => {
		const originalFetch = globalThis.fetch;
		const authHeaders: string[] = [];
		let refreshCalls = 0;
		globalThis.fetch = (async (
			_input: URL | RequestInfo,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers ?? {});
			authHeaders.push(headers.get("Authorization") ?? "");
			if (authHeaders.length === 1) {
				return new Response("unauthorized", { status: 401 });
			}
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: "srv-1",
					result: { ok: true },
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}) as typeof fetch;

		try {
			const client = new HttpMcpClient({
				serverId: "srv",
				url: "https://example.com/mcp",
				protocolVersion: "2025-11-25",
				log: () => {},
				getAccessToken: async () => "token-old",
				refreshAccessToken: async () => {
					refreshCalls += 1;
					return "token-new";
				},
			});

			const result = await client.request(
				"tools/list",
				{},
				{ timeoutMs: 1_000 },
			);
			expect(result).toEqual({ ok: true });
			expect(refreshCalls).toBe(1);
			expect(authHeaders).toEqual(["Bearer token-old", "Bearer token-new"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("accepts streamable HTTP SSE response with control events", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			const sse = [
				"event: endpoint",
				"data: /messages?session_id=abc123",
				"",
				"event: message",
				'data: {"jsonrpc":"2.0","id":"srv-1","result":{"ok":true}}',
				"",
			].join("\n");
			return new Response(sse, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		try {
			const client = new HttpMcpClient({
				serverId: "srv",
				url: "https://example.com/mcp",
				protocolVersion: "2025-11-25",
				log: () => {},
			});
			const result = await client.request(
				"initialize",
				{},
				{ timeoutMs: 1_000 },
			);
			expect(result).toEqual({ ok: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("accepts chunked SSE payloads split across boundaries", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (): Promise<Response> => {
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'event: message\ndata: {"jsonrpc":"2.0","id":"srv-1",',
						),
					);
					controller.enqueue(encoder.encode('"result":{"ok":true}}\n\n'));
					controller.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		}) as unknown as typeof fetch;

		try {
			const client = new HttpMcpClient({
				serverId: "srv",
				url: "https://example.com/mcp",
				protocolVersion: "2025-11-25",
				log: () => {},
			});
			const result = await client.request(
				"initialize",
				{},
				{ timeoutMs: 1_000 },
			);
			expect(result).toEqual({ ok: true });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
