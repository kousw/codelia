import {
	buildProviderFailure,
	classifyTransportFailure,
	extractProviderError,
	isAbortLikeProviderError,
	isValidationStatus,
	type ProviderFailure,
} from "../failures";

const PROVIDER_NAME = "moonshot" as const;

const parseWaitHintMs = (message: string): number | undefined => {
	const match = message.match(
		/(?:retry|wait|try again)\s+(?:after|in|for)?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?)/i,
	);
	if (!match) return undefined;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value < 0) return undefined;
	const unit = match[2]?.toLowerCase() ?? "s";
	if (unit.startsWith("ms")) return Math.round(value);
	if (unit.startsWith("m") && !unit.startsWith("ms")) {
		return Math.round(value * 60_000);
	}
	return Math.round(value * 1000);
};

const isTpdLimit = (message: string): boolean =>
	/\btpd\b|tokens?\s+per\s+day|daily\s+(?:token\s+)?limit|next\s+day/i.test(
		message,
	);

const isShortWindowLimit = (message: string): boolean =>
	/\b(?:rpm|tpm)\b|requests?\s+per\s+minute|tokens?\s+per\s+minute|concurren(?:cy|t)/i.test(
		message,
	);

export const classifyMoonshotFailure = (error: unknown): ProviderFailure => {
	if (isAbortLikeProviderError(error)) {
		return buildProviderFailure(PROVIDER_NAME, "cancelled");
	}
	const extracted = extractProviderError(error);
	const status = extracted.status;
	const type = extracted.type?.toLowerCase() ?? "";
	const message = extracted.message;
	const retryAfterMs = extracted.retryAfterMs ?? parseWaitHintMs(message);
	const delaySource =
		extracted.retryAfterMs !== undefined
			? ("retry-after" as const)
			: retryAfterMs !== undefined
				? ("provider-body" as const)
				: undefined;
	const retryOptions =
		retryAfterMs !== undefined && delaySource
			? { retryAfterMs, delaySource }
			: {};

	if (status === 401) {
		return buildProviderFailure(PROVIDER_NAME, "auth", { status });
	}
	if (status === 403) {
		return buildProviderFailure(PROVIDER_NAME, "permission", { status });
	}
	if (isValidationStatus(status)) {
		return buildProviderFailure(PROVIDER_NAME, "validation", { status });
	}
	if (type === "exceeded_current_quota_error") {
		return buildProviderFailure(PROVIDER_NAME, "hard_quota", { status });
	}
	if (type === "engine_overloaded_error") {
		return buildProviderFailure(PROVIDER_NAME, "overloaded", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 429 && type === "rate_limit_reached_error") {
		if (isTpdLimit(message)) {
			return buildProviderFailure(PROVIDER_NAME, "hard_quota", { status });
		}
		if (isShortWindowLimit(message) || retryAfterMs !== undefined) {
			return buildProviderFailure(PROVIDER_NAME, "rate_limit", {
				status,
				retryable: true,
				...retryOptions,
			});
		}
		return buildProviderFailure(PROVIDER_NAME, "rate_limit", { status });
	}
	if (status === 429) {
		return buildProviderFailure(PROVIDER_NAME, "rate_limit", { status });
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
	if (status === 503) {
		return buildProviderFailure(PROVIDER_NAME, "overloaded", {
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
