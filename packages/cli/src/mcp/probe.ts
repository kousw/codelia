import {
	assertSupportedProtocolVersion,
	getMcpProtocolVersion,
} from "./protocol";
import type { McpServerConfig } from "./types";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const postHttpJson = async (
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	timeoutMs: number,
	redirect: RequestRedirect,
): Promise<{ body: unknown; sessionId?: string }> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
			redirect,
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			const bodyText = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
		}
		const text = await response.text();
		const sessionId = response.headers.get("MCP-Session-Id") ?? undefined;
		if (!text.trim()) return { body: null, sessionId };
		return { body: JSON.parse(text) as unknown, sessionId };
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`request timed out after ${timeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
};

const parseRpcResult = (raw: unknown, requestId: string): unknown => {
	if (Array.isArray(raw)) {
		const found = raw.find(
			(entry) => isRecord(entry) && String(entry.id ?? "") === requestId,
		);
		if (!found) {
			throw new Error(`missing response id=${requestId}`);
		}
		return parseRpcResult(found, requestId);
	}
	if (!isRecord(raw)) {
		throw new Error("invalid JSON-RPC response");
	}
	if (isRecord(raw.error)) {
		throw new Error(
			`RPC ${String(raw.error.code)}: ${String(raw.error.message)}`,
		);
	}
	return raw.result;
};

const parseToolsResponse = (
	raw: unknown,
): { count: number; nextCursor?: string } => {
	if (!isRecord(raw)) return { count: 0 };
	const tools = Array.isArray(raw.tools) ? raw.tools.length : 0;
	const nextCursor =
		typeof raw.nextCursor === "string"
			? raw.nextCursor
			: typeof raw.next_cursor === "string"
				? raw.next_cursor
				: undefined;
	return { count: tools, nextCursor };
};

const probeHttpServer = async (config: McpServerConfig): Promise<number> => {
	let seq = 0;
	let sessionId: string | undefined;
	const timeoutMs = config.request_timeout_ms ?? DEFAULT_MCP_TIMEOUT_MS;
	const protocolVersion = getMcpProtocolVersion();
	const baseHeaders = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"MCP-Protocol-Version": protocolVersion,
		...(config.headers ?? {}),
	};
	const hasConfiguredHeaders = Object.keys(config.headers ?? {}).length > 0;
	const send = async (message: Record<string, unknown>): Promise<unknown> => {
		const raw = await postHttpJson(
			config.url ?? "",
			{ jsonrpc: "2.0", ...message },
			{ ...baseHeaders, ...(sessionId ? { "MCP-Session-Id": sessionId } : {}) },
			timeoutMs,
			hasConfiguredHeaders || sessionId ? "error" : "follow",
		);
		if (raw.sessionId) sessionId = raw.sessionId;
		return raw.body;
	};
	const request = async (method: string, params: unknown): Promise<unknown> => {
		const id = `cli-${++seq}`;
		return parseRpcResult(await send({ id, method, params }), id);
	};

	const initResult = await request("initialize", {
		protocolVersion,
		clientInfo: { name: "codelia-cli", version: "0.1.0" },
		capabilities: {},
	});
	assertSupportedProtocolVersion(initResult);
	await send({ method: "notifications/initialized", params: {} });

	let total = 0;
	let cursor: string | undefined;
	for (let page = 0; page < 100; page += 1) {
		const result = await request("tools/list", cursor ? { cursor } : {});
		const parsed = parseToolsResponse(result);
		total += parsed.count;
		if (!parsed.nextCursor) break;
		cursor = parsed.nextCursor;
	}
	return total;
};

const probeStdioServer = async (
	config: McpServerConfig,
	serverId: string,
): Promise<number> => {
	const { createLocalMcpStdioProbeClient } = await import(
		"@codelia/runtime/sdk"
	);
	const client = await createLocalMcpStdioProbeClient(serverId, config);
	const options = {
		timeoutMs: config.request_timeout_ms ?? DEFAULT_MCP_TIMEOUT_MS,
	};
	try {
		const initResult = await client.request(
			"initialize",
			{
				protocolVersion: getMcpProtocolVersion(),
				clientInfo: { name: "codelia-cli", version: "0.1.0" },
				capabilities: {},
			},
			options,
		);
		assertSupportedProtocolVersion(initResult);
		await client.notify("notifications/initialized", {});
		let total = 0;
		let cursor: string | undefined;
		for (let page = 0; page < 100; page += 1) {
			const result = await client.request(
				"tools/list",
				cursor ? { cursor } : {},
				options,
			);
			const parsed = parseToolsResponse(result);
			total += parsed.count;
			if (!parsed.nextCursor) break;
			cursor = parsed.nextCursor;
		}
		return total;
	} finally {
		await client.close();
	}
};

export const probeServer = async (
	config: McpServerConfig,
	serverId: string,
): Promise<number> => {
	if (config.transport === "http") {
		return probeHttpServer(config);
	}
	return probeStdioServer(config, serverId);
};
