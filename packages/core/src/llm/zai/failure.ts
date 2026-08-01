import {
	asRecord,
	buildProviderFailure,
	classifyTransportFailure,
	extractProviderError,
	isAbortLikeProviderError,
	isValidationStatus,
	type ProviderFailure,
} from "../failures";

const PROVIDER_NAME = "zai" as const;

const readBusinessCode = (error: unknown): number | undefined => {
	const record = asRecord(error);
	const body = asRecord(record?.body);
	const nested = asRecord(body?.error) ?? body;
	const raw = nested?.code ?? record?.code;
	const parsed = typeof raw === "number" ? raw : Number(raw);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
};

export const classifyZaiFailure = (error: unknown): ProviderFailure => {
	if (isAbortLikeProviderError(error)) {
		return buildProviderFailure(PROVIDER_NAME, "cancelled");
	}
	const extracted = extractProviderError(error);
	const status = extracted.status;
	const code = readBusinessCode(error);

	if (status === 401)
		return buildProviderFailure(PROVIDER_NAME, "auth", { status });
	if (status === 403) {
		return buildProviderFailure(PROVIDER_NAME, "permission", { status });
	}
	if (isValidationStatus(status)) {
		return buildProviderFailure(PROVIDER_NAME, "validation", { status });
	}
	if (code === 1302) {
		return buildProviderFailure(PROVIDER_NAME, "rate_limit", {
			status,
			retryable: true,
		});
	}
	if (code === 1305) {
		return buildProviderFailure(PROVIDER_NAME, "overloaded", {
			status,
			retryable: true,
		});
	}
	if (code === 1234) {
		return buildProviderFailure(PROVIDER_NAME, "network", {
			status,
			retryable: true,
		});
	}
	if (
		code === 1113 ||
		code === 1308 ||
		code === 1309 ||
		code === 1310 ||
		(code !== undefined && code >= 1316 && code <= 1321)
	) {
		return buildProviderFailure(PROVIDER_NAME, "hard_quota", { status });
	}
	if (code !== undefined && code >= 1311 && code <= 1315) {
		return buildProviderFailure(PROVIDER_NAME, "permission", { status });
	}
	if (status === 408 || status === 504) {
		return buildProviderFailure(PROVIDER_NAME, "timeout", {
			status,
			retryable: true,
		});
	}
	if (status === 503) {
		return buildProviderFailure(PROVIDER_NAME, "overloaded", {
			status,
			retryable: true,
		});
	}
	if (status !== undefined && status >= 500) {
		return buildProviderFailure(PROVIDER_NAME, "provider", {
			status,
			retryable: true,
		});
	}
	if (status === 429) {
		return buildProviderFailure(PROVIDER_NAME, "provider", { status });
	}
	return (
		classifyTransportFailure(PROVIDER_NAME, error) ??
		buildProviderFailure(PROVIDER_NAME, "provider")
	);
};
