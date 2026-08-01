import { isProviderFailureError, type RunErrorRecord } from "@codelia/core";

export type SafeRunFailure = {
	statusMessage: string;
	error: RunErrorRecord["error"];
	debugMessage: string;
};

export const normalizeRunFailure = (error: Error): SafeRunFailure => {
	if (!isProviderFailureError(error)) {
		return {
			statusMessage: error.message,
			error: {
				name: error.name,
				message: error.message,
				...(error.stack ? { stack: error.stack } : {}),
			},
			debugMessage: `${error.name}: ${error.message}`,
		};
	}
	const { failure } = error;
	const structured: RunErrorRecord["error"] = {
		name: error.name,
		message: failure.safeMessage,
		provider: failure.provider,
		kind: failure.kind,
		attempts: error.attempts,
		max_attempts: error.maxAttempts,
		...(failure.status !== undefined ? { status: failure.status } : {}),
	};
	return {
		statusMessage: failure.safeMessage,
		error: structured,
		debugMessage: [
			`ProviderFailureError: ${failure.safeMessage}`,
			`provider=${failure.provider}`,
			`kind=${failure.kind}`,
			`attempts=${error.attempts}/${error.maxAttempts}`,
			failure.status !== undefined ? `status=${failure.status}` : null,
		]
			.filter((part): part is string => part !== null)
			.join(" "),
	};
};
