import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	assertSupportedProtocolVersion,
	getMcpProtocolVersion,
} from "./protocol";
import type { McpServerConfig } from "./types";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const postHttpJson = async (
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<{ body: unknown; sessionId?: string }> => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: "POST",
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
	const request = async (method: string, params: unknown): Promise<unknown> => {
		seq += 1;
		const requestId = `cli-${seq}`;
		const headers = {
			...baseHeaders,
			...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
		};
		const raw = await postHttpJson(
			config.url ?? "",
			{
				jsonrpc: "2.0",
				id: requestId,
				method,
				params,
			},
			headers,
			timeoutMs,
		);
		if (raw.sessionId) {
			sessionId = raw.sessionId;
		}
		return parseRpcResult(raw.body, requestId);
	};
	const notify = async (method: string, params: unknown): Promise<void> => {
		const headers = {
			...baseHeaders,
			...(sessionId ? { "MCP-Session-Id": sessionId } : {}),
		};
		const raw = await postHttpJson(
			config.url ?? "",
			{
				jsonrpc: "2.0",
				method,
				params,
			},
			headers,
			timeoutMs,
		);
		if (raw.sessionId) {
			sessionId = raw.sessionId;
		}
	};

	const initResult = await request("initialize", {
		protocolVersion,
		clientInfo: { name: "codelia-cli", version: "0.1.0" },
		capabilities: {},
	});
	assertSupportedProtocolVersion(initResult);
	await notify("notifications/initialized", {});

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

const probeStdioServer = async (config: McpServerConfig): Promise<number> => {
	const timeoutMs = config.request_timeout_ms ?? DEFAULT_MCP_TIMEOUT_MS;
	const child = spawn(config.command ?? "", config.args ?? [], {
		cwd: config.cwd,
		env: {
			...process.env,
			...(config.env ?? {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let seq = 0;
	const pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timeout: NodeJS.Timeout;
		}
	>();

	const stdoutReader = createInterface({ input: child.stdout });
	stdoutReader.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return;
		}
		if (!isRecord(parsed) || parsed.id === undefined || parsed.id === null) {
			return;
		}
		const id = String(parsed.id);
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timeout);
		if (isRecord(parsed.error)) {
			entry.reject(
				new Error(
					`RPC ${String(parsed.error.code)}: ${String(parsed.error.message)}`,
				),
			);
			return;
		}
		entry.resolve(parsed.result);
	});

	const stderrReader = createInterface({ input: child.stderr });
	stderrReader.on("line", () => undefined);

	const failPending = (error: Error) => {
		for (const [id, entry] of pending) {
			pending.delete(id);
			clearTimeout(entry.timeout);
			entry.reject(error);
		}
	};

	child.once("error", (error) => {
		failPending(new Error(`stdio process error: ${describeError(error)}`));
	});
	child.once("exit", (code, signal) => {
		failPending(
			new Error(`stdio exited: code=${String(code)} signal=${String(signal)}`),
		);
	});

	const send = (payload: Record<string, unknown>): Promise<void> =>
		new Promise((resolve, reject) => {
			child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});

	const request = (method: string, params: unknown): Promise<unknown> => {
		seq += 1;
		const requestId = `cli-${seq}`;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error(`request timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(requestId, { resolve, reject, timeout });
			void send({
				jsonrpc: "2.0",
				id: requestId,
				method,
				params,
			}).catch((error) => {
				const entry = pending.get(requestId);
				if (!entry) return;
				pending.delete(requestId);
				clearTimeout(entry.timeout);
				reject(new Error(`failed to send request: ${describeError(error)}`));
			});
		});
	};

	const notify = async (method: string, params: unknown): Promise<void> => {
		await send({ jsonrpc: "2.0", method, params });
	};

	try {
		const initResult = await request("initialize", {
			protocolVersion: getMcpProtocolVersion(),
			clientInfo: { name: "codelia-cli", version: "0.1.0" },
			capabilities: {},
		});
		assertSupportedProtocolVersion(initResult);
		await notify("notifications/initialized", {});
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
	} finally {
		child.kill("SIGTERM");
		stdoutReader.close();
		stderrReader.close();
	}
};

export const probeServer = async (config: McpServerConfig): Promise<number> => {
	if (config.transport === "http") {
		return probeHttpServer(config);
	}
	return probeStdioServer(config);
};
