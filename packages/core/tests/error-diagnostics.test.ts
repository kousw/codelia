import { expect, test } from "bun:test";
import {
	createProviderResponseError,
	safeFailureDiagnostic,
} from "../src/llm/error-diagnostics";
import { classifyOpenAiCompatibleFailure } from "../src/llm/failures";
import { invokeWithRetry, resolveLlmRetryPolicy } from "../src/llm/retry";
import { collectGoogleStream } from "../src/llm/google/stream";

test("HTTP errors with statusCode preserve status and intended classification", () => {
	for (const [statusCode, kind] of [
		[400, "validation"],
		[401, "auth"],
		[403, "permission"],
		[429, "rate_limit"],
		[503, "overloaded"],
	] as const) {
		const failure = classifyOpenAiCompatibleFailure("google", {
			statusCode,
			message: "private provider body",
		});
		expect(failure).toMatchObject({ status: statusCode, kind });
		expect(JSON.stringify(failure)).not.toContain("private provider body");
	}
});

test("known nested transport causes survive terminal retry wrapping without raw payloads", async () => {
	const raw = new TypeError("fetch failed api_key=private", {
		cause: Object.assign(new Error("private host and org"), {
			code: "ECONNRESET",
		}),
	});
	const events = invokeWithRetry({
		operation: async () => {
			throw raw;
		},
		classifyFailure: (error) =>
			classifyOpenAiCompatibleFailure("openai", error),
		policy: resolveLlmRetryPolicy({ maxRetries: 0 }),
	});
	try {
		await events.next();
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toMatchObject({
			failure: {
				code: "ECONNRESET",
				detail: "The remote connection was reset.",
			},
		});
		expect(
			JSON.stringify((error as { failure: unknown }).failure),
		).not.toContain("private");
	}
});

test("unknown and circular causes cannot leak arbitrary codes, messages or headers", () => {
	const error: Record<string, unknown> = {
		message: "private",
		code: "api_key=private",
		headers: { authorization: "private" },
	};
	error.cause = error;
	expect(safeFailureDiagnostic(error)).toEqual({});
	expect(
		safeFailureDiagnostic(
			createProviderResponseError("anthropic", "incomplete"),
		),
	).toMatchObject({ code: "response_incomplete" });
});

test("Google stream validation supplies a specific safe cause instead of a generic failure", async () => {
	async function* bad() {
		yield {
			event_type: "step.delta",
			index: -1,
			delta: { type: "text", text: "private generated content" },
		};
	}
	try {
		await collectGoogleStream(bad(), "gemini-4-hydrogen");
		throw new Error("expected failure");
	} catch (error) {
		expect(error).toMatchObject({
			failure: {
				provider: "google",
				code: "response_invalid_step_index",
				retryable: false,
				detail: "The response stream contained an invalid step index.",
			},
		});
		expect(JSON.stringify(error)).not.toContain("private generated content");
	}
});

test("official Google Interactions HTTP errors retain statusCode for common diagnostics", async () => {
	const { GoogleGenAI } = await import("@google/genai");
	const { ChatGoogle } = await import("../src/llm/google/chat");
	const sdk = new GoogleGenAI({
		apiKey: "fixture",
		httpOptions: {
			fetch: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 503,
							status: "UNAVAILABLE",
							message: "private upstream body",
						},
					}),
					{ status: 503, headers: { "content-type": "application/json" } },
				),
		},
	});
	const model = new ChatGoogle({ apiKey: "fixture", client: sdk });
	try {
		await model.ainvoke({ messages: [{ role: "user", content: "hi" }] });
		throw new Error("expected error");
	} catch (error) {
		expect(model.classifyFailure(error)).toMatchObject({
			provider: "google",
			status: 503,
			kind: "overloaded",
		});
		expect(JSON.stringify(model.classifyFailure(error))).not.toContain(
			"private upstream body",
		);
	}
});
