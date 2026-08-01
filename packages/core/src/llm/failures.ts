import type { ProviderName } from "@codelia/shared-types";

export type ProviderFailureKind =
	| "rate_limit"
	| "overloaded"
	| "timeout"
	| "network"
	| "hard_quota"
	| "auth"
	| "permission"
	| "validation"
	| "provider"
	| "cancelled";

export type RetryDelaySource =
	| "retry-after"
	| "reset-header"
	| "provider-body"
	| "backoff";

export type ProviderFailure = {
	provider: ProviderName;
	kind: ProviderFailureKind;
	retryable: boolean;
	safeMessage: string;
	status?: number;
	retryAfterMs?: number;
	delaySource?: Exclude<RetryDelaySource, "backoff">;
	delivery?: "none" | "buffered" | "committed";
};

export type ProviderFailureClassifier = (
	error: unknown,
) => ProviderFailure | null;

export class ProviderFailureError extends Error {
	readonly failure: ProviderFailure;
	readonly attempts: number;
	readonly maxAttempts: number;

	constructor(
		failure: ProviderFailure,
		options: {
			attempts?: number;
			maxAttempts?: number;
			cause?: unknown;
		} = {},
	) {
		super(failure.safeMessage, { cause: options.cause });
		this.name = "ProviderFailureError";
		this.failure = failure;
		this.attempts = options.attempts ?? 1;
		this.maxAttempts = options.maxAttempts ?? this.attempts;
	}
}

export class ProviderTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderTimeoutError";
	}
}

export const isProviderFailureError = (
	error: unknown,
): error is ProviderFailureError => error instanceof ProviderFailureError;

export const asRecord = (
	value: unknown,
): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

export const readString = (
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined => {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const readStatus = (error: unknown): number | undefined => {
	const value = asRecord(error)?.status;
	return typeof value === "number" && Number.isFinite(value)
		? Math.trunc(value)
		: undefined;
};

export type ExtractedProviderError = {
	status?: number;
	type?: string;
	code?: string | number;
	message: string;
	retryAfterMs?: number;
};

export type ProviderRetryHint = {
	retryAfterMs?: number;
	delaySource?: Exclude<RetryDelaySource, "backoff">;
};

const readHeader = (headers: unknown, name: string): string | null => {
	if (headers instanceof Headers) {
		return headers.get(name);
	}
	const record = asRecord(headers);
	if (!record) return null;
	const direct = record[name] ?? record[name.toLowerCase()];
	return typeof direct === "string" ? direct : null;
};

const parsePositiveNumber = (value: string | null): number | undefined => {
	if (!value) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const parseRetryAfterMs = (
	value: string | null,
	nowMs: () => number,
): number | undefined => {
	const seconds = parsePositiveNumber(value);
	if (seconds !== undefined) return Math.round(seconds * 1000);
	if (!value) return undefined;
	const retryAtMs = Date.parse(value.trim());
	return Number.isFinite(retryAtMs)
		? Math.max(0, Math.round(retryAtMs - nowMs()))
		: undefined;
};

export const readRetryAfterMs = (
	error: unknown,
	nowMs: () => number = Date.now,
): number | undefined => {
	const headers = asRecord(error)?.headers;
	const directMs = parsePositiveNumber(readHeader(headers, "retry-after-ms"));
	if (directMs !== undefined) return Math.round(directMs);
	return parseRetryAfterMs(readHeader(headers, "retry-after"), nowMs);
};

export const extractProviderError = (
	error: unknown,
): ExtractedProviderError => {
	const root = asRecord(error);
	const body = asRecord(root?.error);
	const nested = asRecord(body?.error) ?? body;
	const type =
		readString(nested, "type") ??
		readString(body, "type") ??
		readString(root, "type");
	const codeValue = nested?.code ?? body?.code ?? root?.code;
	const code =
		typeof codeValue === "string" || typeof codeValue === "number"
			? codeValue
			: undefined;
	const message =
		readString(nested, "message") ??
		readString(body, "message") ??
		readString(root, "message") ??
		(error instanceof Error ? error.message : "Provider request failed");
	return {
		status: readStatus(error),
		type,
		code,
		message,
		retryAfterMs: readRetryAfterMs(error),
	};
};

export const getRetryHint = (
	extracted: ExtractedProviderError,
): ProviderRetryHint =>
	extracted.retryAfterMs !== undefined
		? {
				retryAfterMs: extracted.retryAfterMs,
				delaySource: "retry-after",
			}
		: {};

export const isValidationStatus = (status: number | undefined): boolean =>
	status === 400 || status === 404 || status === 422;

export const isAbortLikeProviderError = (error: unknown): boolean => {
	const name =
		error instanceof Error ? error.name : readString(asRecord(error), "name");
	return (
		name === "AbortError" ||
		name === "APIUserAbortError" ||
		name === "AbortSignal"
	);
};

const PROVIDER_LABELS: Record<ProviderName, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	openrouter: "OpenRouter",
	google: "Provider",
	moonshot: "Moonshot",
	zai: "Z.ai",
	xai: "xAI",
};

export const safeProviderMessage = (
	provider: ProviderName,
	kind: ProviderFailureKind,
): string => {
	const label = PROVIDER_LABELS[provider];
	switch (kind) {
		case "hard_quota":
			return `${label} quota is exhausted for the interactive retry window. Wait for reset, review billing, or switch provider.`;
		case "rate_limit":
			return `${label} rate limit was reached. Try again shortly or switch provider.`;
		case "overloaded":
			return `${label} is temporarily overloaded. Try again shortly or switch provider.`;
		case "timeout":
			return `${label} request timed out.`;
		case "network":
			return `${label} request failed because of a network error.`;
		case "auth":
			return `${label} authentication failed. Check the configured credentials.`;
		case "permission":
			return `${label} rejected the request because the account lacks permission.`;
		case "validation":
			return `${label} rejected the request as invalid.`;
		case "cancelled":
			return `${label} request was cancelled.`;
		case "provider":
			return `${label} request failed.`;
	}
};

export const buildProviderFailure = (
	provider: ProviderName,
	kind: ProviderFailureKind,
	options: {
		retryable?: boolean;
		status?: number;
		retryAfterMs?: number;
		delaySource?: Exclude<RetryDelaySource, "backoff">;
		delivery?: "none" | "buffered" | "committed";
	} = {},
): ProviderFailure => ({
	provider,
	kind,
	retryable: options.retryable ?? false,
	safeMessage: safeProviderMessage(provider, kind),
	...(options.status !== undefined ? { status: options.status } : {}),
	...(options.retryAfterMs !== undefined
		? { retryAfterMs: options.retryAfterMs }
		: {}),
	...(options.delaySource ? { delaySource: options.delaySource } : {}),
	...(options.delivery ? { delivery: options.delivery } : {}),
});

const MAX_SAFE_PROVIDER_MESSAGE_CHARS = 500;

export const createProviderValidationError = (
	provider: ProviderName,
	message: string,
): ProviderFailureError => {
	const boundedMessage =
		message.length <= MAX_SAFE_PROVIDER_MESSAGE_CHARS
			? message
			: `${message.slice(0, MAX_SAFE_PROVIDER_MESSAGE_CHARS - 3)}...`;
	return new ProviderFailureError({
		...buildProviderFailure(provider, "validation"),
		safeMessage: boundedMessage,
	});
};

export const classifyTransportFailure = (
	provider: ProviderName,
	error: unknown,
): ProviderFailure | null => {
	const name = error instanceof Error ? error.name : "";
	if (name.includes("Timeout")) {
		return buildProviderFailure(provider, "timeout", { retryable: true });
	}
	if (name.includes("Connection") || error instanceof TypeError) {
		return buildProviderFailure(provider, "network", { retryable: true });
	}
	return null;
};

export const classifyOpenAiCompatibleFailure = (
	provider: Extract<ProviderName, "openai" | "openrouter" | "xai">,
	error: unknown,
): ProviderFailure => {
	if (isAbortLikeProviderError(error)) {
		return buildProviderFailure(provider, "cancelled");
	}
	const extracted = extractProviderError(error);
	const status = extracted.status;
	const code = String(extracted.code ?? "").toLowerCase();
	const type = String(extracted.type ?? "").toLowerCase();
	const message = extracted.message.toLowerCase();
	const retryOptions = getRetryHint(extracted);

	if (status === 401) return buildProviderFailure(provider, "auth", { status });
	if (status === 403) {
		return buildProviderFailure(provider, "permission", { status });
	}
	if (isValidationStatus(status)) {
		return buildProviderFailure(provider, "validation", { status });
	}
	if (
		status === 402 ||
		code.includes("insufficient_quota") ||
		type.includes("payment_required") ||
		message.includes("insufficient credit") ||
		message.includes("quota exceeded") ||
		message.includes("exceeded your current quota")
	) {
		return buildProviderFailure(provider, "hard_quota", { status });
	}
	if (status === 408) {
		return buildProviderFailure(provider, "timeout", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status === 409) {
		return buildProviderFailure(provider, "provider", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (
		type.includes("provider_overloaded") ||
		type.includes("provider_unavailable") ||
		status === 529 ||
		status === 503
	) {
		return buildProviderFailure(provider, "overloaded", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (
		status === 429 ||
		type.includes("rate_limit") ||
		code.includes("rate_limit")
	) {
		return buildProviderFailure(provider, "rate_limit", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	if (status !== undefined && status >= 500) {
		return buildProviderFailure(provider, "provider", {
			status,
			retryable: true,
			...retryOptions,
		});
	}
	return (
		classifyTransportFailure(provider, error) ??
		buildProviderFailure(provider, "provider")
	);
};
