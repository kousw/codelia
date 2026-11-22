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

export type {
	McpAuthFile,
	McpBoundServerAuth,
	McpOAuthTokens,
	McpServerAuthBinding,
} from "@codelia/storage";

export type ServerEntry = {
	id: string;
	config: McpServerConfig;
	source: ServerSource;
};
