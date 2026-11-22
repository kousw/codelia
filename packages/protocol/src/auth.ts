export type AuthLogoutParams = {
	/** Omitted clears all providers; a name clears only that provider. */
	provider?: string;
	clear_session?: boolean;
	/**
	 * The client already confirmed with the user; skip `ui.confirm.request`.
	 * Honored only when `supports_auth_management` is advertised.
	 */
	confirmed?: boolean;
};

export type AuthLogoutResult = {
	ok: boolean;
	auth_cleared: boolean;
	session_cleared: boolean;
	cancelled?: boolean;
	provider?: string;
};

/** Sign-in methods accepted by `auth.login`. */
export type AuthMethod = "api_key" | "oauth" | "device_code";

export type AuthStatusParams = {
	/** Omitted returns every configured provider. */
	provider?: string;
};

export type AuthProviderStatus = {
	provider: string;
	/** `config` = a `providers.<id>` endpoint from config.json. */
	kind: "builtin" | "config";
	methods: AuthMethod[];
	/** Saved credential summary; never contains key or token material. */
	saved: {
		method: "api_key" | "oauth";
		/** OAuth access-token expiry (epoch ms); refreshed automatically. */
		expires_at?: number;
	} | null;
	/** API-key environment variable and whether it is set; never its value. */
	env: { name: string; present: boolean } | null;
	/** Provider of the current model selection. */
	active: boolean;
};

export type AuthPendingLogin = {
	login_id: string;
	provider: string;
	method: "oauth" | "device_code";
};

export type AuthStorageMode = "auto" | "keyring" | "file";

export type AuthStorageBackend = "keyring" | "file";

export type AuthStorageFallbackReason =
	| "unsupported_platform"
	| "keychain_locked"
	| "keychain_unavailable";

export type AuthStorageStatus = {
	configured: AuthStorageMode;
	active: AuthStorageBackend;
	state: "steady" | "migrating" | "conflict";
	fallback_reason?: AuthStorageFallbackReason;
};

export type AuthStatusWarningCode =
	| "inline_mcp_config_secrets"
	| "mcp_reauth_required"
	| "storage_conflict"
	| "storage_unreadable"
	| "keychain_locked"
	| "keychain_access_denied"
	| "keychain_unavailable";

export type AuthStatusWarning = {
	code: AuthStatusWarningCode;
	message: string;
	/** Non-secret identifiers (e.g. MCP server IDs or store names). */
	targets?: string[];
};

export type AuthStatusResult = {
	providers: AuthProviderStatus[];
	pending_login?: AuthPendingLogin;
	/** Non-secret credential storage backend summary. */
	storage?: AuthStorageStatus;
	/** Non-secret actionable warnings (e.g. inline MCP secrets or conflict). */
	warnings?: AuthStatusWarning[];
};

export type AuthLoginParams =
	| { provider: string; method: "api_key"; api_key: string }
	| {
			provider: string;
			method: "oauth";
			/** Default `loopback` (localhost callback server); `paste` needs `auth.login.complete`. */
			callback?: "loopback" | "paste";
			/** Default false: the client opens `auth_url` itself. */
			open_browser?: boolean;
	  }
	| { provider: string; method: "device_code"; open_browser?: boolean };

export type AuthLoginResult =
	| {
			status: "completed";
			provider: string;
			method: "api_key";
	  }
	| {
			status: "pending";
			login_id: string;
			provider: string;
			method: "oauth" | "device_code";
			/** OAuth authorization URL. */
			auth_url?: string;
			/** Device-code verification page. */
			verification_url?: string;
			/** Device-code one-time code to show the user. */
			user_code?: string;
	  };

export type AuthLoginCompleteParams = {
	login_id: string;
	/** Redirected callback URL, or `code=...&state=...`. */
	callback_input: string;
};

export type AuthLoginCompleteResult = { ok: true };

export type AuthLoginCancelParams = { login_id: string };

export type AuthLoginCancelResult = { cancelled: boolean };

/** Runtime → UI notification when a pending `auth.login` ends. */
export type AuthLoginStatusNotify = {
	login_id: string;
	provider: string;
	method: "oauth" | "device_code";
	status: "completed" | "failed" | "cancelled";
	/** Redacted failure reason. */
	message?: string;
};

export type AuthStorageConflictStrategy =
	| "keep_keyring"
	| "keep_file"
	| "keep_legacy"
	| "clear_all";

export type AuthStorageResolveConflictParams = {
	strategy: AuthStorageConflictStrategy;
	/** Defaults to both `auth` and `mcp_auth` when omitted. */
	stores?: Array<"auth" | "mcp_auth">;
	/**
	 * The client already confirmed the resolution with the user; skip
	 * `ui.confirm.request`.
	 */
	confirmed?: boolean;
};

export type AuthStorageResolveConflictResult = {
	ok: boolean;
	active?: AuthStorageBackend;
	resolved_stores: Array<"auth" | "mcp_auth">;
	cancelled?: boolean;
};
