import { describe, expect, test } from "bun:test";
import {
	buildProviderFailure,
	ProviderFailureError,
} from "../src/llm/failures";
import {
	invokeWithRetry,
	type LlmRetryPolicy,
	resolveLlmRetryPolicy,
} from "../src/llm/retry";

const policy: LlmRetryPolicy = {
	maxRetries: 2,
	baseDelayMs: 1000,
	maxDelayMs: 60_000,
	maxRetryAfterMs: 60_000,
	overallDeadlineMs: 120_000,
};

const drain = async <T>(
	iterator: AsyncGenerator<unknown, T>,
): Promise<{ events: unknown[]; result: T }> => {
	const events: unknown[] = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) return { events, result: next.value };
		events.push(next.value);
	}
};

describe("invokeWithRetry", () => {
	test("normalizes retry policy overrides without changing defaults", () => {
		expect(resolveLlmRetryPolicy()).toEqual({
			maxRetries: 2,
			baseDelayMs: 1000,
			maxDelayMs: 60_000,
			maxRetryAfterMs: 60_000,
			overallDeadlineMs: 1_200_000,
		});
		expect(
			resolveLlmRetryPolicy({
				maxRetries: 4.9,
				baseDelayMs: -1,
				maxDelayMs: Number.NaN,
				maxRetryAfterMs: 12_345.9,
				overallDeadlineMs: 0,
			}),
		).toEqual({
			maxRetries: 4,
			baseDelayMs: 1000,
			maxDelayMs: 60_000,
			maxRetryAfterMs: 12_345,
			overallDeadlineMs: 1_200_000,
		});
	});

	test("fails hard quota immediately without sleeping", async () => {
		let calls = 0;
		let sleeps = 0;
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				calls += 1;
				throw new Error("raw quota id=secret");
			},
			classifyFailure: () => buildProviderFailure("moonshot", "hard_quota"),
			policy,
			dependencies: {
				sleep: async () => {
					sleeps += 1;
				},
			},
		});

		await expect(drain(iterator)).rejects.toMatchObject({
			name: "ProviderFailureError",
			failure: { kind: "hard_quota" },
			attempts: 1,
		});
		expect(calls).toBe(1);
		expect(sleeps).toBe(0);
	});

	test("emits visible retry data and succeeds on the next attempt", async () => {
		let calls = 0;
		const waits: number[] = [];
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				calls += 1;
				if (calls === 1) throw new Error("short rate limit");
				return "ok";
			},
			classifyFailure: () =>
				buildProviderFailure("moonshot", "rate_limit", {
					retryable: true,
					retryAfterMs: 12_000,
					delaySource: "provider-body",
					status: 429,
				}),
			policy,
			dependencies: {
				nowMs: () => 0,
				sleep: async (delayMs) => {
					waits.push(delayMs);
				},
			},
		});

		const { events, result } = await drain(iterator);
		expect(result).toBe("ok");
		expect(calls).toBe(2);
		expect(waits).toEqual([12_000]);
		expect(events).toEqual([
			{
				type: "llm.retry",
				provider: "moonshot",
				failure_kind: "rate_limit",
				next_attempt: 2,
				max_attempts: 3,
				delay_ms: 12_000,
				delay_source: "provider-body",
				status: 429,
			},
		]);
	});

	test("rejects a provider wait above the automatic retry ceiling", async () => {
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				throw new Error("wait until tomorrow");
			},
			classifyFailure: () =>
				buildProviderFailure("moonshot", "rate_limit", {
					retryable: true,
					retryAfterMs: 86 * 60 * 1000,
					delaySource: "retry-after",
				}),
			policy,
		});

		let caught: unknown;
		try {
			await drain(iterator);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ProviderFailureError);
		expect((caught as ProviderFailureError).message).toContain(
			"longer than Codelia's automatic retry limit",
		);
	});

	test("reports exhausted attempts with the final attempt count", async () => {
		let calls = 0;
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				calls += 1;
				throw new Error("short rate limit");
			},
			classifyFailure: () =>
				buildProviderFailure("moonshot", "rate_limit", {
					retryable: true,
				}),
			policy: { ...policy, maxRetries: 1 },
			dependencies: {
				nowMs: () => 0,
				random: () => 1,
				sleep: async () => {},
			},
		});

		await expect(drain(iterator)).rejects.toMatchObject({
			name: "ProviderFailureError",
			attempts: 2,
			maxAttempts: 2,
			failure: { kind: "rate_limit", retryable: false },
		});
		expect(calls).toBe(2);
	});

	test("aborts promptly while waiting between attempts", async () => {
		const controller = new AbortController();
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				throw new Error("short rate limit");
			},
			classifyFailure: () =>
				buildProviderFailure("moonshot", "rate_limit", {
					retryable: true,
					retryAfterMs: 1000,
				}),
			policy,
			signal: controller.signal,
			dependencies: {
				nowMs: () => 0,
				sleep: (_delayMs, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() =>
								reject(
									Object.assign(new Error("aborted"), { name: "AbortError" }),
								),
							{ once: true },
						);
					}),
			},
		});

		const first = await iterator.next();
		expect(first.value).toMatchObject({ type: "llm.retry", next_attempt: 2 });
		const waiting = iterator.next();
		controller.abort();
		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
	});

	test("reports overall deadline during backoff as timeout, not cancellation", async () => {
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				throw new Error("rate limit");
			},
			classifyFailure: () =>
				buildProviderFailure("moonshot", "rate_limit", {
					retryable: true,
					retryAfterMs: 1,
				}),
			policy: { ...policy, overallDeadlineMs: 10 },
			dependencies: {
				nowMs: () => 0,
				sleep: (_delayMs, signal) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener(
							"abort",
							() =>
								reject(
									Object.assign(new Error("aborted"), { name: "AbortError" }),
								),
							{ once: true },
						);
					}),
			},
		});

		const first = await iterator.next();
		expect(first.value).toMatchObject({ type: "llm.retry" });
		await expect(iterator.next()).rejects.toMatchObject({
			name: "ProviderFailureError",
			failure: { kind: "timeout" },
		});
	});

	test("does not retry a buffered provider failure", async () => {
		let calls = 0;
		const failure = buildProviderFailure("moonshot", "overloaded", {
			retryable: false,
			delivery: "buffered",
		});
		const iterator = invokeWithRetry({
			provider: "moonshot",
			operation: async () => {
				calls += 1;
				throw new ProviderFailureError(failure);
			},
			policy,
		});

		await expect(drain(iterator)).rejects.toMatchObject({
			failure: { delivery: "buffered", retryable: false },
		});
		expect(calls).toBe(1);
	});
});
