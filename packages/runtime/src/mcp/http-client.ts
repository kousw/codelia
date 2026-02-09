import type { McpClient, McpRequestOptions } from "./client";
import {
	buildCancelParams,
	CANCELLED_METHOD,
	createAbortError,
	describeError,
	JSON_RPC_VERSION,
	type JsonRpcResponse,
	normalizeRpcError,
} from "./jsonrpc";
import { readJsonBody } from "./sse";

export type HttpClientOptions = {
	serverId: string;
	url: string;
	headers?: Record<string, string>;
	protocolVersion: string;
	log: (message: string) => void;
	getAccessToken?: () => Promise<string | undefined>;
	refreshAccessToken?: () => Promise<string | undefined>;
};

export class McpHttpError extends Error {
	readonly status: number;
	readonly body: string;
	readonly headers: Headers;

	constructor(
		status: number,
		serverId: string,
		body: string,
		headers: Headers,
	) {
		const snippet = body ? body.slice(0, 500) : "(empty)";
		super(`MCP HTTP ${status} (${serverId}): ${snippet}`);
		this.name = "McpHttpError";
		this.status = status;
		this.body = body;
		this.headers = headers;
	}
}

export const isMcpHttpAuthError = (error: unknown): error is McpHttpError =>
	error instanceof McpHttpError && error.status === 401;

export class HttpMcpClient implements McpClient {
	private sequence = 0;
	private sessionId: string | null = null;

	constructor(private readonly options: HttpClientOptions) {}

	private nextRequestId(): string {
		this.sequence += 1;
		return `${this.options.serverId}-${this.sequence}`;
	}

	private buildHeaders(
		accessToken?: string,
		additional?: Record<string, string>,
	): Headers {
		const headers = new Headers();
		headers.set("Content-Type", "application/json");
		headers.set("Accept", "application/json, text/event-stream");
		headers.set("MCP-Protocol-Version", this.options.protocolVersion);
		if (this.sessionId) {
			headers.set("MCP-Session-Id", this.sessionId);
		}
		if (accessToken) {
			headers.set("Authorization", `Bearer ${accessToken}`);
		}
		for (const [key, value] of Object.entries(this.options.headers ?? {})) {
			headers.set(key, value);
		}
		for (const [key, value] of Object.entries(additional ?? {})) {
			headers.set(key, value);
		}
		return headers;
	}

	private async post(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
		accessToken?: string,
	): Promise<unknown> {
		const response = await fetch(this.options.url, {
			method: "POST",
			headers: this.buildHeaders(accessToken),
			body: JSON.stringify(payload),
			signal,
		});
		const headerSessionId = response.headers.get("MCP-Session-Id");
		if (headerSessionId) {
			this.sessionId = headerSessionId;
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new McpHttpError(
				response.status,
				this.options.serverId,
				body,
				response.headers,
			);
		}
		const expectedRequestId =
			typeof payload.id === "string" || typeof payload.id === "number"
				? String(payload.id)
				: undefined;
		return readJsonBody(response, expectedRequestId);
	}

	private async postWithAuthRetry(
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const token = this.options.getAccessToken
			? await this.options.getAccessToken()
			: undefined;
		try {
			return await this.post(payload, signal, token);
		} catch (error) {
			if (!this.options.refreshAccessToken || !isMcpHttpAuthError(error)) {
				throw error;
			}
			const refreshedToken = await this.options.refreshAccessToken();
			if (!refreshedToken) {
				throw error;
			}
			this.options.log(
				`mcp[${this.options.serverId}] unauthorized, retrying with refreshed token`,
			);
			return this.post(payload, signal, refreshedToken);
		}
	}

	async request(
		method: string,
		params: unknown,
		options: McpRequestOptions,
	): Promise<unknown> {
		const requestId = this.nextRequestId();
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort();
		}, options.timeoutMs);
		let cleanupAbort: (() => void) | undefined;
		if (options.signal) {
			const onAbort = () => {
				controller.abort();
				void this.notify(
					CANCELLED_METHOD,
					buildCancelParams(requestId, "aborted"),
				).catch((error) => {
					this.options.log(
						`mcp[${this.options.serverId}] cancel notify failed: ${describeError(error)}`,
					);
				});
			};
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
				cleanupAbort = () => {
					options.signal?.removeEventListener("abort", onAbort);
				};
			}
		}

		try {
			const raw = await this.postWithAuthRetry(
				{
					jsonrpc: JSON_RPC_VERSION,
					id: requestId,
					method,
					params,
				},
				controller.signal,
			);
			if (!raw) return null;
			const response = raw as JsonRpcResponse | JsonRpcResponse[];
			const message = Array.isArray(response)
				? response.find((entry) => String(entry.id) === requestId)
				: response;
			if (!message) {
				throw new Error(`MCP HTTP response missing id=${requestId}`);
			}
			if (message.error) {
				throw normalizeRpcError(method, message.error);
			}
			return message.result;
		} catch (error) {
			if (controller.signal.aborted) {
				throw createAbortError(`MCP request aborted (${method})`);
			}
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			clearTimeout(timeout);
			if (cleanupAbort) cleanupAbort();
		}
	}

	async notify(method: string, params: unknown): Promise<void> {
		await this.postWithAuthRetry({
			jsonrpc: JSON_RPC_VERSION,
			method,
			params,
		});
	}

	async close(): Promise<void> {}
}
