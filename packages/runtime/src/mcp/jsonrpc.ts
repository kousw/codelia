export const JSON_RPC_VERSION = "2.0";
export const CANCELLED_METHOD = "notifications/cancelled";

export type JsonRpcError = {
	code: number;
	message: string;
	data?: unknown;
};

export type JsonRpcResponse = {
	jsonrpc?: string;
	id?: string | number;
	result?: unknown;
	error?: JsonRpcError;
};

export const createAbortError = (message: string): Error => {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const normalizeRpcError = (method: string, error: JsonRpcError): Error =>
	new Error(`MCP ${method} error (${error.code}): ${error.message}`);

export const toLine = (value: Record<string, unknown>): string =>
	`${JSON.stringify(value)}\n`;

export const buildCancelParams = (
	requestId: string,
	reason: string,
): Record<string, unknown> => ({
	requestId,
	reason,
});
