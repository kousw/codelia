import type { ResponsesProviderConfig } from "@codelia/config";
import {
	type AuthLoginCancelParams,
	type AuthLoginCompleteParams,
	type AuthLoginParams,
	type AuthLoginResult,
	type AuthLoginStatusNotify,
	type AuthMethod,
	type AuthProviderStatus,
	type AuthStatusParams,
	type AuthStatusResult,
	type AuthStatusWarning,
	type AuthStorageConflictStrategy,
	type AuthStorageResolveConflictParams,
	type AuthStorageResolveConflictResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import {
	CredentialConflictError,
	inspectCredentialStorageStatus,
	KeychainError,
	mcpAuthStoreAdapter,
	providerAuthStoreAdapter,
	resolveCredentialConflict,
	resolveStoragePaths,
} from "@codelia/storage";
import { createOpenAiDeviceCodeSession } from "../auth/openai-device-code";
import {
	createOAuthSession,
	type OpenAiTokenResponse,
	openBrowser,
} from "../auth/openai-oauth";
import {
	configuredApiKeyAuth,
	configuredProviders,
	providerApiKeyEnvName,
	providerAuthMethods,
	readProviderEnvApiKey,
	SUPPORTED_PROVIDERS,
	toStoredOpenAiOAuth,
} from "../auth/resolver";
import {
	type AuthFileV2,
	AuthStore,
	getChatProviderAuth,
	type ProviderAuth,
	setProviderChatAuth,
} from "../auth/store";
import { resolveConfigLayers } from "../config";
import { resolveEnvironmentModelConfig } from "../environment-services";
import { detectInlineMcpConfigSecrets } from "../mcp/config-secret-warnings";
import { runtimeLocalAutoReview } from "../permissions/local-reviewer";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendNotificationAsync, sendResult } from "./transport";
import { requestUiConfirm } from "./ui-requests";

const PROVIDER_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const MAX_API_KEY_LENGTH = 4096;
const MAX_CALLBACK_INPUT_LENGTH = 8192;
const MAX_FAILURE_MESSAGE_LENGTH = 300;

type AuthDeps = { state: RuntimeState; log: (message: string) => void };

type PendingLogin = {
	id: string;
	provider: string;
	method: "oauth" | "device_code";
	settled: boolean;
	stop: () => void;
	completeFromInput?: (input: string) => Promise<OpenAiTokenResponse>;
};

const workingDirOf = (state: RuntimeState): string | undefined =>
	state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined;

const uniqueProviders = (
	providers?: Record<string, ResponsesProviderConfig>,
): string[] => [...new Set(configuredProviders(providers))];

const failureMessage = (error: unknown): string => {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > MAX_FAILURE_MESSAGE_LENGTH
		? `${text.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}…`
		: text;
};

/** True when runtime owns credentials and can run the `auth.*` management family. */
export const supportsAuthManagement = (state: RuntimeState): boolean =>
	state.effectiveEnvironment.auth.model === "runtime-default";

/** Drops cached agents that may hold credentials of `provider`. */
const invalidateForProvider = (state: RuntimeState, provider: string): void => {
	runtimeLocalAutoReview(state).revokeAuth(provider);
	const current =
		state.currentModelProvider ?? state.sessionModelOverride?.provider ?? null;
	if (provider === current || state.cachedAuthProviders.has(provider)) {
		state.requestAgentInvalidation();
	}
};

/** Queued reload-then-merge write so concurrent credential changes survive. */
const saveProviderAuth = async (
	provider: string,
	auth: ProviderAuth,
): Promise<void> => {
	await new AuthStore().updateV2((file) => {
		setProviderChatAuth(file, provider, auth);
	});
};

export const createAuthManagementHandlers = ({ state, log }: AuthDeps) => {
	let pending: PendingLogin | null = null;
	let loginSeq = 0;

	const rejectUnsupported = (id: string): boolean => {
		if (supportsAuthManagement(state)) return false;
		sendError(id, {
			code: RPC_ERROR_CODE.INVALID_PARAMS,
			message: "auth is host-owned",
		});
		return true;
	};

	const notifyLogin = (
		login: PendingLogin,
		status: AuthLoginStatusNotify["status"],
		message?: string,
	): void => {
		const params: AuthLoginStatusNotify = {
			login_id: login.id,
			provider: login.provider,
			method: login.method,
			status,
			...(message ? { message } : {}),
		};
		void sendNotificationAsync(state, {
			jsonrpc: "2.0",
			method: "auth.login.status",
			params,
		});
	};

	const settle = (login: PendingLogin): boolean => {
		if (login.settled) return false;
		login.settled = true;
		if (pending === login) pending = null;
		try {
			login.stop();
		} catch {
			/* stopping is best effort */
		}
		return true;
	};

	const finishLogin = async (
		login: PendingLogin,
		tokens: OpenAiTokenResponse,
	): Promise<void> => {
		// Claim the login before persisting so a concurrent cancel cannot report
		// success while the credential is still written.
		if (!settle(login)) return;
		try {
			await saveProviderAuth(login.provider, {
				method: "oauth",
				oauth: toStoredOpenAiOAuth(tokens),
			});
		} catch {
			notifyLogin(login, "failed", "saving credentials failed");
			return;
		}
		invalidateForProvider(state, login.provider);
		notifyLogin(login, "completed");
		log(
			`auth.login completed provider=${login.provider} method=${login.method}`,
		);
	};

	const failLogin = (login: PendingLogin, error: unknown): void => {
		if (!settle(login)) return;
		notifyLogin(login, "failed", failureMessage(error));
		log(`auth.login failed provider=${login.provider} method=${login.method}`);
	};

	const resolveProviders = async () => {
		const config = await resolveEnvironmentModelConfig(
			state,
			workingDirOf(state),
		);
		return { config, providers: uniqueProviders(config.providers) };
	};

	const handleStatus = async (
		id: string,
		params: AuthStatusParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const requested = params?.provider;
		if (
			requested !== undefined &&
			(typeof requested !== "string" || !PROVIDER_NAME_PATTERN.test(requested))
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "invalid provider name",
			});
			return;
		}
		try {
			const { config, providers } = await resolveProviders();
			if (requested !== undefined && !providers.includes(requested)) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: `unknown provider: ${requested}`,
				});
				return;
			}
			const storageStatus = await inspectCredentialStorageStatus({
				paths: resolveStoragePaths(),
				authAdapter: providerAuthStoreAdapter,
				mcpAdapter: mcpAuthStoreAdapter,
			});
			const warnings: AuthStatusWarning[] = [];
			if (storageStatus.conflictStores.length > 0) {
				warnings.push({
					code: "storage_conflict",
					message:
						"Conflicting credentials exist in multiple storage locations. Resolve the conflict before signing in or running.",
					targets: storageStatus.conflictStores,
				});
			}
			if (storageStatus.mcpReauthRequired.length > 0) {
				warnings.push({
					code: "mcp_reauth_required",
					message:
						"Legacy unbound MCP OAuth tokens were dropped during migration and require re-authentication.",
					targets: storageStatus.mcpReauthRequired,
				});
			}
			const configLayers = await resolveConfigLayers(workingDirOf(state)).catch(
				() => ({ globalConfig: null, projectConfig: null }),
			);
			const inlineSecretServers = [
				...new Set([
					...detectInlineMcpConfigSecrets(
						configLayers.globalConfig?.mcp?.servers,
					).map((f) => f.serverId),
					...detectInlineMcpConfigSecrets(
						configLayers.projectConfig?.mcp?.servers,
					).map((f) => f.serverId),
				]),
			].sort();
			if (inlineSecretServers.length > 0) {
				warnings.push({
					code: "inline_mcp_config_secrets",
					message:
						"Inline MCP secrets in config.json remain readable by confined agents; move them out of config.json when possible.",
					targets: inlineSecretServers,
				});
			}

			let auth: AuthFileV2 = { version: 2, providers: {} };
			if (storageStatus.state !== "conflict") {
				try {
					auth = await new AuthStore().loadV2();
				} catch (error) {
					if (
						!(error instanceof CredentialConflictError) &&
						!(error instanceof KeychainError)
					) {
						throw error;
					}
					if (
						error instanceof CredentialConflictError &&
						!warnings.some((w) => w.code === "storage_conflict")
					) {
						warnings.push({
							code: "storage_conflict",
							message:
								"Conflicting credentials exist in multiple storage locations.",
							targets: [error.store],
						});
					}
				}
			}
			const active =
				state.currentModelProvider ??
				state.sessionModelOverride?.provider ??
				config.provider ??
				"openai";
			const builtin = new Set<string>(SUPPORTED_PROVIDERS);
			const entries: AuthProviderStatus[] = providers
				.filter((provider) => requested === undefined || provider === requested)
				.map((provider) => {
					const saved = getChatProviderAuth(auth, provider);
					const envName = providerApiKeyEnvName(provider, config.providers);
					return {
						provider,
						kind:
							config.providers && Object.hasOwn(config.providers, provider)
								? "config"
								: builtin.has(provider)
									? "builtin"
									: "config",
						methods: providerAuthMethods(provider, config.providers),
						saved: saved
							? saved.method === "oauth"
								? { method: "oauth", expires_at: saved.oauth.expires_at }
								: { method: "api_key" }
							: null,
						env: envName
							? {
									name: envName,
									present: Boolean(
										readProviderEnvApiKey(provider, config.providers),
									),
								}
							: null,
						active: provider === active,
					};
				});
			const result: AuthStatusResult = {
				providers: entries,
				...(pending
					? {
							pending_login: {
								login_id: pending.id,
								provider: pending.provider,
								method: pending.method,
							},
						}
					: {}),
				storage: {
					configured: storageStatus.configured,
					active: storageStatus.active,
					state: storageStatus.state,
					...(storageStatus.fallbackReason
						? { fallback_reason: storageStatus.fallbackReason }
						: {}),
				},
				...(warnings.length > 0 ? { warnings } : {}),
			};
			sendResult(id, result);
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "auth status failed",
			});
		}
	};

	const handleLogin = async (
		id: string,
		params: AuthLoginParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const provider = params?.provider;
		const method = params?.method as AuthMethod | undefined;
		if (typeof provider !== "string" || !PROVIDER_NAME_PATTERN.test(provider)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "invalid provider name",
			});
			return;
		}
		let providers: string[];
		let providerConfigs: Record<string, ResponsesProviderConfig> | undefined;
		try {
			const resolved = await resolveProviders();
			providers = resolved.providers;
			providerConfigs = resolved.config.providers;
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "auth login failed",
			});
			return;
		}
		if (!providers.includes(provider)) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unknown provider: ${provider}`,
			});
			return;
		}
		if (
			!method ||
			!providerAuthMethods(provider, providerConfigs).includes(method)
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: `unsupported auth method for ${provider}`,
			});
			return;
		}
		if (method === "api_key") {
			const raw = (params as { api_key?: unknown }).api_key;
			const apiKey = typeof raw === "string" ? raw.trim() : "";
			if (!apiKey || apiKey.length > MAX_API_KEY_LENGTH || /\s/.test(apiKey)) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "api_key must be a non-empty single-line string",
				});
				return;
			}
			let saved: "saved" | "busy";
			try {
				// Recheck idleness under the admission lock so no run starts mid-write.
				saved = await state.withAdmissionLock(async () => {
					if (state.activeRunId) return "busy" as const;
					await saveProviderAuth(
						provider,
						configuredApiKeyAuth(provider, apiKey),
					);
					invalidateForProvider(state, provider);
					return "saved" as const;
				});
			} catch {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
					message: "saving credentials failed",
				});
				return;
			}
			if (saved === "busy") {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_BUSY,
					message: "runtime busy",
				});
				return;
			}
			sendResult(id, {
				status: "completed",
				provider,
				method: "api_key",
			} satisfies AuthLoginResult);
			log(`auth.login completed provider=${provider} method=api_key`);
			return;
		}
		if (pending) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "another login is pending",
			});
			return;
		}
		const typed = params as { callback?: unknown; open_browser?: unknown };
		if (
			typed.callback !== undefined &&
			typed.callback !== "loopback" &&
			typed.callback !== "paste"
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "callback must be loopback or paste",
			});
			return;
		}
		const openInBrowser = typed.open_browser === true;
		loginSeq += 1;
		// Reserve the single pending slot before any await so concurrent requests
		// cannot both start a login; session hooks are attached once it exists.
		const login: PendingLogin = {
			id: `login-${Date.now().toString(36)}-${loginSeq}`,
			provider,
			method,
			settled: false,
			stop: () => {},
		};
		pending = login;
		/** True when the login was cancelled while its session was being created. */
		const cancelledDuringSetup = (stop: () => void): boolean => {
			if (!login.settled) {
				login.stop = stop;
				return false;
			}
			stop();
			sendError(id, {
				code: RPC_ERROR_CODE.USER_CANCELLED,
				message: "login cancelled",
			});
			return true;
		};
		try {
			if (method === "oauth") {
				const session = await createOAuthSession({
					callbackMode: typed.callback === "paste" ? "paste" : "server",
				});
				if (cancelledDuringSetup(session.stop)) return;
				login.completeFromInput = session.completeFromInput;
				sendResult(id, {
					status: "pending",
					login_id: login.id,
					provider,
					method,
					auth_url: session.authUrl,
				} satisfies AuthLoginResult);
				if (openInBrowser) openBrowser(session.authUrl);
				if (typed.callback !== "paste") {
					session.waitForTokens().then(
						(tokens) => finishLogin(login, tokens),
						(error) => failLogin(login, error),
					);
				}
			} else {
				const session = await createOpenAiDeviceCodeSession();
				const abort = new AbortController();
				if (cancelledDuringSetup(() => abort.abort())) return;
				sendResult(id, {
					status: "pending",
					login_id: login.id,
					provider,
					method: "device_code",
					verification_url: session.verificationUrl,
					user_code: session.userCode,
				} satisfies AuthLoginResult);
				if (openInBrowser) openBrowser(session.verificationUrl);
				session.complete(abort.signal).then(
					(tokens) => finishLogin(login, tokens),
					(error) => failLogin(login, error),
				);
			}
			log(`auth.login pending provider=${provider} method=${method}`);
		} catch (error) {
			login.settled = true;
			if (pending === login) pending = null;
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: `auth login failed: ${failureMessage(error)}`,
			});
		}
	};

	const handleLoginComplete = async (
		id: string,
		params: AuthLoginCompleteParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const login = pending;
		if (!login || login.id !== params?.login_id) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "no matching pending login",
			});
			return;
		}
		const input = params?.callback_input;
		if (
			!login.completeFromInput ||
			typeof input !== "string" ||
			!input.trim() ||
			input.length > MAX_CALLBACK_INPUT_LENGTH
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "callback_input is required for a pending OAuth login",
			});
			return;
		}
		let completion: Promise<OpenAiTokenResponse>;
		try {
			completion = login.completeFromInput(input.trim());
		} catch {
			// Unparseable input or state mismatch: keep the login pending for a retry.
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "invalid OAuth callback input",
			});
			return;
		}
		sendResult(id, { ok: true });
		completion.then(
			(tokens) => finishLogin(login, tokens),
			(error) => failLogin(login, error),
		);
	};

	const handleLoginCancel = async (
		id: string,
		params: AuthLoginCancelParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		const login = pending;
		if (!login || login.id !== params?.login_id) {
			sendResult(id, { cancelled: false });
			return;
		}
		settle(login);
		sendResult(id, { cancelled: true });
		notifyLogin(login, "cancelled");
		log(`auth.login cancelled provider=${login.provider}`);
	};

	const handleResolveConflict = async (
		id: string,
		params: AuthStorageResolveConflictParams | undefined,
	): Promise<void> => {
		if (rejectUnsupported(id)) return;
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const strategy = params?.strategy;
		const validStrategies = new Set<AuthStorageConflictStrategy>([
			"keep_keyring",
			"keep_file",
			"keep_legacy",
			"clear_all",
		]);
		if (
			typeof strategy !== "string" ||
			!validStrategies.has(strategy as AuthStorageConflictStrategy)
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message:
					"strategy must be one of keep_keyring, keep_file, keep_legacy, or clear_all",
			});
			return;
		}
		let stores: Array<"auth" | "mcp_auth"> = ["auth", "mcp_auth"];
		if (params?.stores !== undefined) {
			if (
				!Array.isArray(params.stores) ||
				params.stores.length === 0 ||
				!params.stores.every((s) => s === "auth" || s === "mcp_auth")
			) {
				sendError(id, {
					code: RPC_ERROR_CODE.INVALID_PARAMS,
					message: "stores must be a non-empty array of 'auth' or 'mcp_auth'",
				});
				return;
			}
			stores = [...new Set(params.stores)];
		}
		if (
			params?.confirmed !== undefined &&
			typeof params.confirmed !== "boolean"
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "confirmed must be a boolean",
			});
			return;
		}
		const preconfirmed = params?.confirmed === true;
		if (!preconfirmed && !state.uiCapabilities?.supports_confirm) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "UI confirmation is required to resolve credential conflicts",
			});
			return;
		}
		if (!preconfirmed) {
			const confirm = await requestUiConfirm(state, {
				title: "Resolve credential storage conflict",
				message: `Apply '${strategy}' to ${stores.join(", ")} credential store(s)? Competing copies will be removed.`,
				confirm_label: "Apply",
				cancel_label: "Cancel",
				danger_level: "danger",
				allow_remember: false,
				allow_reason: false,
			});
			if (!confirm?.ok) {
				sendResult(id, {
					ok: false,
					resolved_stores: [],
					cancelled: true,
				} satisfies AuthStorageResolveConflictResult);
				return;
			}
		}
		try {
			const resolved = await state.withAdmissionLock(async () => {
				if (state.activeRunId) {
					throw new Error("runtime busy");
				}
				return resolveCredentialConflict({
					paths: resolveStoragePaths(),
					authAdapter: providerAuthStoreAdapter,
					mcpAdapter: mcpAuthStoreAdapter,
					strategy: strategy as AuthStorageConflictStrategy,
					stores,
				});
			});
			runtimeLocalAutoReview(state).revokeAuth();
			state.requestAgentInvalidation();
			sendResult(id, {
				ok: true,
				active: resolved.active,
				resolved_stores: resolved.resolvedStores,
			} satisfies AuthStorageResolveConflictResult);
			log(
				`auth.storage.resolve_conflict strategy=${strategy} stores=${resolved.resolvedStores.join(",")} active=${resolved.active}`,
			);
		} catch (error) {
			if (error instanceof Error && error.message === "runtime busy") {
				sendError(id, {
					code: RPC_ERROR_CODE.RUNTIME_BUSY,
					message: "runtime busy",
				});
				return;
			}
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: `failed to resolve credential conflict: ${failureMessage(error)}`,
			});
		}
	};

	return {
		handleStatus,
		handleLogin,
		handleLoginComplete,
		handleLoginCancel,
		handleResolveConflict,
	};
};
