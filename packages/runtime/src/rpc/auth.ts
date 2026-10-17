import {
	type AuthLogoutParams,
	type AuthLogoutResult,
	RPC_ERROR_CODE,
} from "@codelia/protocol";
import { configuredProviders } from "../auth/resolver";
import { AuthStore } from "../auth/store";
import { resolveEnvironmentModelConfig } from "../environment-services";
import type { RuntimeState } from "../runtime-state";
import { sendError, sendResult } from "./transport";
import { requestUiConfirm } from "./ui-requests";

export const createAuthLogoutHandler =
	({ state, log }: { state: RuntimeState; log: (message: string) => void }) =>
	async (id: string, params: AuthLogoutParams | undefined): Promise<void> => {
		if (state.activeRunId) {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_BUSY,
				message: "runtime busy",
			});
			return;
		}
		const provider = params?.provider;
		if (
			provider !== undefined &&
			(typeof provider !== "string" ||
				!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(provider))
		) {
			sendError(id, {
				code: RPC_ERROR_CODE.INVALID_PARAMS,
				message: "invalid logout provider name",
			});
			return;
		}
		try {
			const hostAuth = state.effectiveEnvironment.auth.model === "host";
			const config = provider
				? await resolveEnvironmentModelConfig(
						state,
						state.lastUiContext?.cwd ?? state.runtimeWorkingDir ?? undefined,
					)
				: undefined;
			const currentProvider =
				state.currentModelProvider ??
				state.sessionModelOverride?.provider ??
				config?.provider ??
				(hostAuth ? undefined : "openai");
			const affectsCurrent =
				provider === undefined || provider === currentProvider;
			const clearSession = (params?.clear_session ?? true) && affectsCurrent;
			if (hostAuth) {
				const credentials =
					state.effectiveEnvironment.adapters.credentialProvider;
				if (
					provider ? !credentials?.clearProviderAuth : !credentials?.clearAuth
				) {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
						message: provider
							? "host auth provider does not support scoped logout"
							: "host auth provider does not support logout",
					});
					return;
				}
				if (provider) await credentials?.clearProviderAuth?.(provider);
				else await credentials?.clearAuth?.();
			} else {
				const store = new AuthStore();
				if (provider) {
					const auth = await store.load();
					if (
						!Object.hasOwn(auth.providers, provider) &&
						!configuredProviders(config?.providers).includes(provider)
					) {
						sendError(id, {
							code: RPC_ERROR_CODE.INVALID_PARAMS,
							message: `unknown logout provider: ${provider}`,
						});
						return;
					}
				}
				if (!state.uiCapabilities?.supports_confirm) {
					sendError(id, {
						code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
						message: "UI confirmation is required for logout",
					});
					return;
				}
				const confirm = await requestUiConfirm(state, {
					title: provider ? `Log out of ${provider}` : "Confirm logout",
					message: provider
						? `This clears saved credentials for ${provider} only.${clearSession ? " The current session will be reset." : " The current session will be kept."} Continue?`
						: `This clears all local auth credentials.${clearSession ? " The current session will be reset." : " The current session will be kept."} Continue?`,
					confirm_label: "Yes",
					cancel_label: "No",
					danger_level: "danger",
					allow_remember: false,
					allow_reason: false,
				});
				if (!confirm?.ok) {
					sendResult(id, {
						ok: false,
						auth_cleared: false,
						session_cleared: false,
						cancelled: true,
						...(provider ? { provider } : {}),
					} satisfies AuthLogoutResult);
					return;
				}
				// Reload after confirmation so unrelated credentials added while waiting survive.
				if (provider) {
					const auth = await store.load();
					delete auth.providers[provider];
					await store.save(auth);
				} else await store.save({ version: 1, providers: {} });
			}
			if (affectsCurrent) state.agent = null;
			if (clearSession) {
				state.sessionId = null;
				state.sessionMeta = null;
				state.sessionAppend = null;
				state.sessionModelOverride = null;
			}
			sendResult(id, {
				ok: true,
				auth_cleared: true,
				session_cleared: clearSession,
				...(provider ? { provider } : {}),
			} satisfies AuthLogoutResult);
			log(
				`auth.logout provider=${provider ?? "all"} session_cleared=${clearSession}`,
			);
		} catch {
			sendError(id, {
				code: RPC_ERROR_CODE.RUNTIME_INTERNAL,
				message: "auth logout failed",
			});
		}
	};
