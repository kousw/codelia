import {
	buildProviderFailure,
	classifyTransportFailure,
	extractProviderError,
	getRetryHint,
	isAbortLikeProviderError,
	isValidationStatus,
	type ProviderFailure,
} from "../failures";

const PROVIDER_NAME = "anthropic" as const;

export const classifyAnthropicFailure = (error: unknown): ProviderFailure => {
	if (isAbortLikeProviderError(error)) {
		return buildProviderFailure(PROVIDER_NAME, "cancelled");
	}
	const extracted = extractProviderError(error);
	const status = extracted.status;
	const type = extracted.type?.toLowerCase() ?? "";
	const retryOptions = getRetryHint(extracted);

	if (status === 401) {
		return buildProviderFailure(PROVIDER_NAME, "auth", { status });
	}
	if (status === 402 || type === "billing_error") {
		return buildProviderFailure(PROVIDER_NAME, "hard_quota", { status });
	}
	if (status === 403) {
		return buildProviderFailure(PROVIDER_NAME, "permission", { status });
	}
	if (isValidationStatus(status)) {
		return buildProviderFailure(PROVIDER_NAME, "validation", { status });
	}
	if (status === 429 || type === "rate_limit_error") {
		return buildProviderFailure(PROVIDER_NAME, "rate_limit", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 408) {
		return buildProviderFailure(PROVIDER_NAME, "timeout", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 409) {
		return buildProviderFailure(PROVIDER_NAME, "provider", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 529 || type === "overloaded_error") {
		return buildProviderFailure(PROVIDER_NAME, "overloaded", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 504 || type === "timeout_error") {
		return buildProviderFailure(PROVIDER_NAME, "timeout", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status !== undefined && status >= 500) {
		return buildProviderFailure(PROVIDER_NAME, "provider", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	return (
		classifyTransportFailure(PROVIDER_NAME, error) ??
		buildProviderFailure(PROVIDER_NAME, "provider")
	);
};
