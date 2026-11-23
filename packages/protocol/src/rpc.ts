import { z } from "zod";

export type RpcId = string;

export const RPC_ERROR_CODE = {
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	RUNTIME_INTERNAL: -32000,
	RUNTIME_BUSY: -32001,
	RUN_NOT_FOUND: -32002,
	USER_CANCELLED: -32003,
	SESSION_NOT_FOUND: -32004,
	SESSION_LOAD_FAILED: -32005,
	SESSION_LIST_FAILED: -32006,
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODE)[keyof typeof RPC_ERROR_CODE];

/** Error data for catalog validation failures. Other INVALID_PARAMS
 * responses may omit data or carry a method-specific payload. */
export const ProtocolIssueSchema = z
	.object({ path: z.string(), code: z.string(), message: z.string() })
	.meta({ id: "ProtocolIssue" });
export type ProtocolIssue = z.infer<typeof ProtocolIssueSchema>;

export const InvalidParamsErrorDataSchema = z
	.object({ issues: z.array(ProtocolIssueSchema) })
	.meta({ id: "InvalidParamsErrorData" });
export type InvalidParamsErrorData = z.infer<
	typeof InvalidParamsErrorDataSchema
>;

export type RpcError<Data = unknown> = {
	code: RpcErrorCode;
	message: string;
	data?: Data;
};

export type RpcRequest = {
	jsonrpc: "2.0";
	id: RpcId;
	method: string;
	params?: unknown;
};

export type RpcResponse = {
	jsonrpc: "2.0";
	id: RpcId;
	result?: unknown;
	error?: RpcError;
};

export type RpcNotification = {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;
