export type RpcId = string;

export type RpcError = {
	code: number;
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
