import { tagged, wireInt } from "@codelia/shared-types";
import { z } from "zod";

export const AuthLogoutParamsSchema = z
	.object({
		/** Omitted clears all providers; a name clears only that provider. */
		provider: z.string().optional(),
		clear_session: z.boolean().optional(),
		/**
		 * The client already confirmed with the user; skip `ui.confirm.request`.
		 * Honored only when `supports_auth_management` is advertised.
		 */
		confirmed: z.boolean().optional(),
	})
	.meta({ id: "AuthLogoutParams" });
export type AuthLogoutParams = z.infer<typeof AuthLogoutParamsSchema>;

export const AuthLogoutResultSchema = z
	.object({
		ok: z.boolean(),
		auth_cleared: z.boolean(),
		session_cleared: z.boolean(),
		cancelled: z.boolean().optional(),
		provider: z.string().optional(),
	})
	.meta({ id: "AuthLogoutResult" });
export type AuthLogoutResult = z.infer<typeof AuthLogoutResultSchema>;

/** Sign-in methods accepted by `auth.login`. */
export const AuthMethodSchema = z
	.enum(["api_key", "oauth", "device_code"])
	.meta({ id: "AuthMethod" });
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/** Sign-in methods that finish asynchronously. */
export const AuthPendingMethodSchema = z
	.enum(["oauth", "device_code"])
	.meta({ id: "AuthPendingMethod" });

export const AuthStatusParamsSchema = z
	.object({
		/** Omitted returns every configured provider. */
		provider: z.string().optional(),
	})
	.meta({ id: "AuthStatusParams" });
export type AuthStatusParams = z.infer<typeof AuthStatusParamsSchema>;

/** Saved credential summary; never contains key or token material. */
export const AuthSavedCredentialSchema = z
	.object({
		method: z.enum(["api_key", "oauth"]),
		/** OAuth access-token expiry (epoch ms); refreshed automatically. */
		expires_at: wireInt().optional(),
	})
	.meta({ id: "AuthSavedCredential" });

/** API-key environment variable and whether it is set; never its value. */
export const AuthEnvCredentialSchema = z
	.object({ name: z.string(), present: z.boolean() })
	.meta({ id: "AuthEnvCredential" });

export const AuthProviderStatusSchema = z
	.object({
		provider: z.string(),
		/** `config` = a `providers.<id>` endpoint from config.json. */
		kind: z.enum(["builtin", "config"]),
		methods: z.array(AuthMethodSchema),
		saved: AuthSavedCredentialSchema.nullable(),
		env: AuthEnvCredentialSchema.nullable(),
		/** Provider of the current model selection. */
		active: z.boolean(),
	})
	.meta({ id: "AuthProviderStatus" });
export type AuthProviderStatus = z.infer<typeof AuthProviderStatusSchema>;

export const AuthPendingLoginSchema = z
	.object({
		login_id: z.string(),
		provider: z.string(),
		method: AuthPendingMethodSchema,
	})
	.meta({ id: "AuthPendingLogin" });
export type AuthPendingLogin = z.infer<typeof AuthPendingLoginSchema>;

export const AuthStatusResultSchema = z
	.object({
		providers: z.array(AuthProviderStatusSchema),
		pending_login: AuthPendingLoginSchema.optional(),
	})
	.meta({ id: "AuthStatusResult" });
export type AuthStatusResult = z.infer<typeof AuthStatusResultSchema>;

export const AuthLoginApiKeyParamsSchema = z
	.object({
		provider: z.string(),
		method: z.literal("api_key"),
		api_key: z.string(),
	})
	.meta({ id: "AuthLoginApiKeyParams" });

export const AuthLoginOAuthParamsSchema = z
	.object({
		provider: z.string(),
		method: z.literal("oauth"),
		/** Default `loopback` (localhost callback server); `paste` needs `auth.login.complete`. */
		callback: z.enum(["loopback", "paste"]).optional(),
		/** Default false: the client opens `auth_url` itself. */
		open_browser: z.boolean().optional(),
	})
	.meta({ id: "AuthLoginOAuthParams" });

export const AuthLoginDeviceCodeParamsSchema = z
	.object({
		provider: z.string(),
		method: z.literal("device_code"),
		open_browser: z.boolean().optional(),
	})
	.meta({ id: "AuthLoginDeviceCodeParams" });

export const AuthLoginParamsSchema = tagged(
	"method",
	[
		AuthLoginApiKeyParamsSchema,
		AuthLoginOAuthParamsSchema,
		AuthLoginDeviceCodeParamsSchema,
	],
	{ id: "AuthLoginParams" },
);
export type AuthLoginParams = z.infer<typeof AuthLoginParamsSchema>;

export const AuthLoginCompletedSchema = z
	.object({
		status: z.literal("completed"),
		provider: z.string(),
		method: z.literal("api_key"),
	})
	.meta({ id: "AuthLoginCompleted" });

export const AuthLoginPendingSchema = z
	.object({
		status: z.literal("pending"),
		login_id: z.string(),
		provider: z.string(),
		method: AuthPendingMethodSchema,
		/** OAuth authorization URL. */
		auth_url: z.string().optional(),
		/** Device-code verification page. */
		verification_url: z.string().optional(),
		/** Device-code one-time code to show the user. */
		user_code: z.string().optional(),
	})
	.meta({ id: "AuthLoginPending" });

export const AuthLoginResultSchema = tagged(
	"status",
	[AuthLoginCompletedSchema, AuthLoginPendingSchema],
	{ id: "AuthLoginResult" },
);
export type AuthLoginResult = z.infer<typeof AuthLoginResultSchema>;

export const AuthLoginCompleteParamsSchema = z
	.object({
		login_id: z.string(),
		/** Redirected callback URL, or `code=...&state=...`. */
		callback_input: z.string(),
	})
	.meta({ id: "AuthLoginCompleteParams" });
export type AuthLoginCompleteParams = z.infer<
	typeof AuthLoginCompleteParamsSchema
>;

export const AuthLoginCompleteResultSchema = z
	.object({ ok: z.literal(true) })
	.meta({ id: "AuthLoginCompleteResult" });
export type AuthLoginCompleteResult = z.infer<
	typeof AuthLoginCompleteResultSchema
>;

export const AuthLoginCancelParamsSchema = z
	.object({ login_id: z.string() })
	.meta({ id: "AuthLoginCancelParams" });
export type AuthLoginCancelParams = z.infer<typeof AuthLoginCancelParamsSchema>;

export const AuthLoginCancelResultSchema = z
	.object({ cancelled: z.boolean() })
	.meta({ id: "AuthLoginCancelResult" });
export type AuthLoginCancelResult = z.infer<typeof AuthLoginCancelResultSchema>;

/** Runtime → UI notification when a pending `auth.login` ends. */
export const AuthLoginStatusNotifySchema = z
	.object({
		login_id: z.string(),
		provider: z.string(),
		method: AuthPendingMethodSchema,
		status: z.enum(["completed", "failed", "cancelled"]),
		/** Redacted failure reason. */
		message: z.string().optional(),
	})
	.meta({ id: "AuthLoginStatusNotify" });
export type AuthLoginStatusNotify = z.infer<typeof AuthLoginStatusNotifySchema>;
