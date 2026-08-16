import type { LlmRetryEvent } from "@codelia/shared-types";
import {
	isProviderFailureError,
	ProviderFailureError,
	type ProviderFailure,
	type ProviderFailureClassifier,
	type RetryDelaySource,
} from "./failures";

export type LlmRetryPolicy = {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	maxRetryAfterMs: number;
	retryWindowMs: number;
};

export const DEFAULT_LLM_RETRY_POLICY: Readonly<LlmRetryPolicy> = {
	maxRetries: 2,
	baseDelayMs: 1000,
	maxDelayMs: 60_000,
	maxRetryAfterMs: 60_000,
	retryWindowMs: 20 * 60 * 1000,
};

const finitePolicyValue = (
	value: number | undefined,
	fallback: number,
	minimum: number,
): number =>
	typeof value === "number" && Number.isFinite(value) && value >= minimum
		? Math.trunc(value)
		: fallback;

export const resolveLlmRetryPolicy = (
	overrides: Partial<LlmRetryPolicy> = {},
): LlmRetryPolicy => ({
	maxRetries: finitePolicyValue(
		overrides.maxRetries,
		DEFAULT_LLM_RETRY_POLICY.maxRetries,
		0,
	),
	baseDelayMs: finitePolicyValue(
		overrides.baseDelayMs,
		DEFAULT_LLM_RETRY_POLICY.baseDelayMs,
		0,
	),
	maxDelayMs: finitePolicyValue(
		overrides.maxDelayMs,
		DEFAULT_LLM_RETRY_POLICY.maxDelayMs,
		0,
	),
	maxRetryAfterMs: finitePolicyValue(
		overrides.maxRetryAfterMs,
		DEFAULT_LLM_RETRY_POLICY.maxRetryAfterMs,
		0,
	),
	retryWindowMs: finitePolicyValue(
		overrides.retryWindowMs,
		DEFAULT_LLM_RETRY_POLICY.retryWindowMs,
		1,
	),
});

export type LlmRetryDependencies = {
	nowMs?: () => number;
	random?: () => number;
	sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
};

export type InvokeWithRetryOptions<T> = {
	operation: (signal?: AbortSignal) => Promise<T>;
	classifyFailure?: ProviderFailureClassifier;
	policy: LlmRetryPolicy;
	signal?: AbortSignal;
	dependencies?: LlmRetryDependencies;
};

const createAbortError = (): Error => {
	const error = new Error("Operation aborted");
	error.name = "AbortError";
	return error;
};

const defaultSleep = (delayMs: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
			() => {
				timeout = undefined;
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, delayMs),
		);
		const onAbort = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			signal?.removeEventListener("abort", onAbort);
			reject(createAbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

const createRetryWindowSignal = (
	parent: AbortSignal | undefined,
	windowMs: number,
): {
	signal: AbortSignal;
	didExpire: () => boolean;
	cleanup: () => void;
} => {
	const controller = new AbortController();
	let expired = false;
	const onParentAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) {
		onParentAbort();
	} else {
		parent?.addEventListener("abort", onParentAbort, { once: true });
	}
	const timeout = setTimeout(() => {
		expired = true;
		controller.abort(new Error("LLM retry window elapsed"));
	}, windowMs);
	return {
		signal: controller.signal,
		didExpire: () => expired,
		cleanup: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", onParentAbort);
		},
	};
};

const toClassifiedFailure = (
	error: unknown,
	classifyFailure: ProviderFailureClassifier | undefined,
): ProviderFailure | null => {
	if (isProviderFailureError(error)) return error.failure;
	return classifyFailure?.(error) ?? null;
};

type RetryStopReason =
	| "retry_exhausted"
	| "retry_after_too_long"
	| "retry_window_elapsed";

const RETRY_STOP_SUFFIXES: Record<RetryStopReason, string> = {
	retry_exhausted: " Automatic retry attempts were exhausted.",
	retry_after_too_long:
		" The provider requested a wait longer than Codelia's automatic retry limit.",
	retry_window_elapsed:
		" The automatic retry window elapsed before another attempt could start.",
};

const withFinalMessage = (
	failure: ProviderFailure,
	reason: RetryStopReason,
): ProviderFailure => {
	return {
		...failure,
		retryable: false,
		safeMessage: `${failure.safeMessage}${RETRY_STOP_SUFFIXES[reason]}`,
	};
};

const createTerminalProviderError = (options: {
	failure: ProviderFailure;
	attempt: number;
	maxAttempts: number;
	cause?: unknown;
	reason?: RetryStopReason;
}): ProviderFailureError =>
	new ProviderFailureError(
		options.reason
			? withFinalMessage(options.failure, options.reason)
			: options.failure,
		{
			attempts: options.attempt,
			maxAttempts: options.maxAttempts,
			...(options.cause !== undefined ? { cause: options.cause } : {}),
		},
	);

const calculateBackoffMs = (
	attempt: number,
	policy: LlmRetryPolicy,
	random: () => number,
): number => {
	const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const jittered =
		exponential * (0.5 + Math.min(1, Math.max(0, random())) * 0.5);
	return Math.min(policy.maxDelayMs, Math.max(0, Math.round(jittered)));
};

type RetryDecision =
	| {
			type: "retry";
			delayMs: number;
			delaySource: RetryDelaySource;
	  }
	| {
			type: "stop";
			failure: ProviderFailure;
			reason?: RetryStopReason;
	  };

const planRetry = (options: {
	failure: ProviderFailure;
	attempt: number;
	maxAttempts: number;
	elapsedMs: number;
	policy: LlmRetryPolicy;
	random: () => number;
}): RetryDecision => {
	const { failure, attempt, maxAttempts, elapsedMs, policy, random } = options;
	if (!failure.retryable) return { type: "stop", failure };
	if (attempt >= maxAttempts) {
		return { type: "stop", failure, reason: "retry_exhausted" };
	}
	if (
		failure.retryAfterMs !== undefined &&
		failure.retryAfterMs > policy.maxRetryAfterMs
	) {
		return { type: "stop", failure, reason: "retry_after_too_long" };
	}
	const delayMs =
		failure.retryAfterMs ?? calculateBackoffMs(attempt, policy, random);
	if (elapsedMs + delayMs >= policy.retryWindowMs) {
		return { type: "stop", failure, reason: "retry_window_elapsed" };
	}
	return {
		type: "retry",
		delayMs,
		delaySource: failure.delaySource ?? "backoff",
	};
};

const toRetryEvent = (
	failure: ProviderFailure,
	options: {
		nextAttempt: number;
		maxAttempts: number;
		delayMs: number;
		delaySource: RetryDelaySource;
	},
): LlmRetryEvent => ({
	type: "llm.retry",
	provider: failure.provider,
	failure_kind: failure.kind as LlmRetryEvent["failure_kind"],
	next_attempt: options.nextAttempt,
	max_attempts: options.maxAttempts,
	delay_ms: options.delayMs,
	delay_source: options.delaySource,
	...(failure.status !== undefined ? { status: failure.status } : {}),
});

export async function* invokeWithRetry<T>({
	operation,
	classifyFailure,
	policy,
	signal,
	dependencies = {},
}: InvokeWithRetryOptions<T>): AsyncGenerator<LlmRetryEvent, T> {
	const nowMs = dependencies.nowMs ?? Date.now;
	const random = dependencies.random ?? Math.random;
	const sleep = dependencies.sleep ?? defaultSleep;
	const maxAttempts = Math.max(1, Math.trunc(policy.maxRetries) + 1);
	const startedAt = nowMs();
	// The retry window limits only backoff and whether another attempt may start.
	// Active requests use provider-owned connect/first-byte/idle timeouts so a
	// healthy stream is not aborted merely because total wall time crossed this window.
	const retryWindow = createRetryWindowSignal(signal, policy.retryWindowMs);
	let attempt = 1;
	try {
		while (true) {
			if (signal?.aborted) throw createAbortError();
			try {
				return await operation(signal);
			} catch (error) {
				if (signal?.aborted) throw createAbortError();
				const failure = toClassifiedFailure(error, classifyFailure);
				if (!failure) throw error;
				if (failure.kind === "cancelled") throw createAbortError();
				const decision = planRetry({
					failure,
					attempt,
					maxAttempts,
					elapsedMs: retryWindow.didExpire()
						? policy.retryWindowMs
						: Math.max(0, nowMs() - startedAt),
					policy,
					random,
				});
				if (decision.type === "stop") {
					throw createTerminalProviderError({
						failure: decision.failure,
						attempt,
						maxAttempts,
						cause: error,
						...(decision.reason ? { reason: decision.reason } : {}),
					});
				}
				yield toRetryEvent(failure, {
					nextAttempt: attempt + 1,
					maxAttempts,
					delayMs: decision.delayMs,
					delaySource: decision.delaySource,
				});
				try {
					await sleep(decision.delayMs, retryWindow.signal);
				} catch (sleepError) {
					if (signal?.aborted) throw createAbortError();
					if (retryWindow.didExpire()) {
						throw createTerminalProviderError({
							failure,
							attempt,
							maxAttempts,
							cause: sleepError,
							reason: "retry_window_elapsed",
						});
					}
					throw sleepError;
				}
				if (
					retryWindow.didExpire() ||
					Math.max(0, nowMs() - startedAt) >= policy.retryWindowMs
				) {
					throw createTerminalProviderError({
						failure,
						attempt,
						maxAttempts,
						reason: "retry_window_elapsed",
					});
				}
				attempt += 1;
			}
		}
	} finally {
		retryWindow.cleanup();
	}
}
