import { isProviderFailureError, type RunErrorRecord } from "@codelia/core";
import type { RunErrorInfo } from "@codelia/shared-types";

export type SafeRunFailure = {
	statusMessage: string;
	statusError: RunErrorInfo;
	error: RunErrorRecord["error"];
	debugMessage: string;
};

const nextStep = (kind?: string): string => {
	switch (kind) {
		case "auth":
			return "Check the selected provider's credentials and account, then sign in again.";
		case "permission":
			return "Check that this account can access the selected model.";
		case "hard_quota":
			return "Review the provider's balance or quota, or select another provider with /model.";
		case "rate_limit":
			return "Wait for the rate limit to reset, then retry.";
		case "overloaded":
			return "Retry shortly, or select another provider with /model.";
		case "network":
			return "Check network/proxy settings, then retry.";
		case "timeout":
			return "Retry; if it repeats, check network/proxy settings and request timeouts.";
		case "validation":
			return "Review the selected model and request settings; /errors show has the safe details.";
		default:
			return "Retry; if it repeats, share the details from /errors show.";
	}
};

export const normalizeRunFailure = (error: Error): SafeRunFailure => {
	if (!isProviderFailureError(error)) {
		const statusError: RunErrorInfo = {
			name: error.name,
			message: error.message,
			hint: nextStep(),
		};
		return {
			statusMessage: error.message,
			statusError,
			error: {
				name: error.name,
				message: error.message,
				hint: statusError.hint,
				...(error.stack ? { stack: error.stack } : {}),
			},
			debugMessage: `${error.name}: ${error.message}`,
		};
	}
	const { failure } = error;
	const statusError: RunErrorInfo = {
		name: error.name,
		message: failure.safeMessage,
		provider: failure.provider,
		kind: failure.kind,
		attempts: error.attempts,
		max_attempts: error.maxAttempts,
		...(failure.code ? { code: failure.code } : {}),
		...(failure.status !== undefined ? { status: failure.status } : {}),
		...(failure.detail
			? { detail: failure.detail }
			: failure.status === undefined
				? {
						detail:
							"No HTTP status or recognized transport cause was reported.",
					}
				: {}),
		hint: nextStep(failure.kind),
	};
	return {
		statusMessage: failure.safeMessage,
		statusError,
		error: { ...statusError, kind: failure.kind },
		debugMessage: JSON.stringify(statusError),
	};
};
