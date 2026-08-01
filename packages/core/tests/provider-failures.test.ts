import { describe, expect, test } from "bun:test";
import { classifyAnthropicFailure } from "../src/llm/anthropic/failure";
import {
	classifyOpenAiCompatibleFailure,
	ProviderTimeoutError,
	readRetryAfterMs,
	safeProviderMessage,
} from "../src/llm/failures";
import { classifyMoonshotFailure } from "../src/llm/moonshot/failure";
import { classifyZaiFailure } from "../src/llm/zai/failure";

describe("provider failure classification", () => {
	test("classifies Moonshot TPD 429 as immediate hard quota", () => {
		const failure = classifyMoonshotFailure({
			status: 429,
			error: {
				type: "rate_limit_reached_error",
				message:
					"request reached organization TPD rate limit, current: 1560799, limit: 1500000, api_key=secret",
			},
		});

		expect(failure).toMatchObject({
			provider: "moonshot",
			kind: "hard_quota",
			retryable: false,
			status: 429,
		});
		expect(failure.safeMessage).not.toContain("1560799");
		expect(failure.safeMessage).not.toContain("secret");
	});

	test("classifies Moonshot short-window rate limit with a bounded wait hint", () => {
		const failure = classifyMoonshotFailure({
			status: 429,
			error: {
				type: "rate_limit_reached_error",
				message: "RPM limit reached, retry after 12 seconds",
			},
		});

		expect(failure).toMatchObject({
			kind: "rate_limit",
			retryable: true,
			retryAfterMs: 12_000,
			delaySource: "provider-body",
		});
	});

	test("does not guess an unknown Moonshot 429 into a retryable category", () => {
		const failure = classifyMoonshotFailure({
			status: 429,
			error: { type: "unknown_limit", message: "limit reached" },
		});

		expect(failure).toMatchObject({
			kind: "rate_limit",
			retryable: false,
		});
	});

	test("separates OpenAI exhausted credits from short rate limits", () => {
		const quota = classifyOpenAiCompatibleFailure("openai", {
			status: 429,
			error: { code: "insufficient_quota", message: "billing identifier" },
		});
		const shortLimit = classifyOpenAiCompatibleFailure("openai", {
			status: 429,
			error: { type: "rate_limit_error", message: "too many requests" },
			headers: new Headers({ "retry-after": "2" }),
		});

		expect(quota).toMatchObject({ kind: "hard_quota", retryable: false });
		expect(shortLimit).toMatchObject({
			kind: "rate_limit",
			retryable: true,
			retryAfterMs: 2000,
		});
	});

	test("honors a standard Retry-After HTTP date", () => {
		const nowMs = Date.UTC(2026, 7, 1, 12, 0, 0);
		const retryAt = new Date(nowMs + 30_000).toUTCString();

		expect(
			readRetryAfterMs(
				{ headers: new Headers({ "retry-after": retryAt }) },
				() => nowMs,
			),
		).toBe(30_000);
	});

	test("keeps adapter-owned timeouts eligible for bounded retry", () => {
		const error = new ProviderTimeoutError("adapter request timeout");

		expect(classifyOpenAiCompatibleFailure("openai", error)).toMatchObject({
			kind: "timeout",
			retryable: true,
		});
		expect(classifyZaiFailure(error)).toMatchObject({
			kind: "timeout",
			retryable: true,
		});
	});

	test("preserves SDK-equivalent 408 and 409 retry coverage", () => {
		for (const classify of [
			(error: unknown) => classifyOpenAiCompatibleFailure("openai", error),
			classifyAnthropicFailure,
			classifyMoonshotFailure,
		]) {
			expect(classify({ status: 408 })).toMatchObject({
				kind: "timeout",
				retryable: true,
			});
			expect(classify({ status: 409 })).toMatchObject({
				kind: "provider",
				retryable: true,
			});
		}
	});

	test("classifies Anthropic billing and overload separately", () => {
		expect(
			classifyAnthropicFailure({ status: 402, type: "billing_error" }),
		).toMatchObject({ kind: "hard_quota", retryable: false });
		expect(
			classifyAnthropicFailure({ status: 529, type: "overloaded_error" }),
		).toMatchObject({ kind: "overloaded", retryable: true });
	});

	test("uses Z.ai business codes before the shared 429 status", () => {
		const shortLimit = classifyZaiFailure({
			status: 429,
			body: { error: { code: 1302, message: "limit" } },
		});
		const weeklyLimit = classifyZaiFailure({
			status: 429,
			body: { error: { code: 1317, message: "weekly limit" } },
		});

		expect(shortLimit).toMatchObject({ kind: "rate_limit", retryable: true });
		expect(weeklyLimit).toMatchObject({ kind: "hard_quota", retryable: false });
	});

	test("keeps shared validation and transport fallbacks consistent", () => {
		for (const classify of [
			(error: unknown) => classifyOpenAiCompatibleFailure("openai", error),
			classifyAnthropicFailure,
			classifyMoonshotFailure,
			classifyZaiFailure,
		]) {
			expect(classify({ status: 422 })).toMatchObject({
				kind: "validation",
				retryable: false,
			});
			expect(classify(new TypeError("network detail"))).toMatchObject({
				kind: "network",
				retryable: true,
			});
		}
	});

	test("keeps the existing provider labels in safe messages", () => {
		expect(safeProviderMessage("moonshot", "provider")).toBe(
			"Moonshot request failed.",
		);
		expect(safeProviderMessage("google", "provider")).toBe(
			"Provider request failed.",
		);
	});
});
