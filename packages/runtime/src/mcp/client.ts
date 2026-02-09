export type McpRequestOptions = {
	timeoutMs: number;
	signal?: AbortSignal;
};

export type McpClient = {
	request(
		method: string,
		params: unknown,
		options: McpRequestOptions,
	): Promise<unknown>;
	notify(method: string, params: unknown): Promise<void>;
	close(): Promise<void>;
};

export {
	type HttpClientOptions,
	HttpMcpClient,
	isMcpHttpAuthError,
	McpHttpError,
} from "./http-client";
export { type StdioClientOptions, StdioMcpClient } from "./stdio-client";
