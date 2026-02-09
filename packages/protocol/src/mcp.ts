export type McpListScope = "loaded" | "configured";

export type McpServerTransport = "http" | "stdio";

export type McpServerState =
	| "disabled"
	| "connecting"
	| "auth_required"
	| "ready"
	| "error";

export type McpListParams = {
	scope?: McpListScope;
};

export type McpListServer = {
	id: string;
	transport: McpServerTransport;
	source?: "project" | "global";
	enabled: boolean;
	state: McpServerState;
	tools?: number;
	last_error?: string;
	last_connected_at?: string;
};

export type McpListResult = {
	servers: McpListServer[];
};
