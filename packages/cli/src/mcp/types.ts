export type Scope = "project" | "global" | "effective";
export type ServerSource = "project" | "global";
export type McpTransport = "http" | "stdio";

export type McpServerConfig = {
	transport: McpTransport;
	enabled?: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	request_timeout_ms?: number;
	oauth?: {
		authorization_url?: string;
		token_url?: string;
		registration_url?: string;
		client_id?: string;
		client_secret?: string;
		scope?: string;
	};
};

export type McpOAuthTokens = {
	access_token: string;
	refresh_token?: string;
	expires_at?: number;
	token_type?: string;
	scope?: string;
	client_id?: string;
	client_secret?: string;
};

export type McpAuthFile = {
	version: 1;
	servers: Record<string, McpOAuthTokens>;
};

export type ServerEntry = {
	id: string;
	config: McpServerConfig;
	source: ServerSource;
};
