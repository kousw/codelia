export type RpcId = string;

export const RPC_ERROR_CODE = {
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

export type RpcError = {
	code: RpcErrorCode;
	message: string;
	data?: unknown;
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
