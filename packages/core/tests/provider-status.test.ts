import { expect, test } from "bun:test";
import type { LlmStatusEvent } from "@codelia/shared-types";
import { withProviderStatus } from "../src/llm/provider-status";
import { invokeWithRetry, resolveLlmRetryPolicy } from "../src/llm/retry";

const status: LlmStatusEvent = {
	type: "llm.status",
	provider: "openai",
	kind: "buffering",
	active: true,
};

test("closing the stream at a progress event aborts the pending provider and suppresses late status", async () => {
	let aborted = false;
	let emitLater!: (event: LlmStatusEvent) => void;
	const events = withProviderStatus((emit, signal) =>
		invokeWithRetry({
			policy: resolveLlmRetryPolicy({ maxRetries: 0 }),
			signal,
			operation: async () => {
				emitLater = emit;
				emit(status);
				return new Promise<string>((_resolve, reject) =>
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("cancelled"));
						},
						{ once: true },
					),
				);
			},
		}),
	);
	expect((await events.next()).value).toEqual(status);
	await events.return("stopped");
	expect(aborted).toBe(true);
	emitLater(status);
	expect((await events.next()).done).toBe(true);
});

test("provider status is delivered before a terminal failure and the error remains an error", async () => {
	const events = withProviderStatus((emit, signal) =>
		invokeWithRetry({
			policy: resolveLlmRetryPolicy({ maxRetries: 0 }),
			signal,
			operation: async () => {
				emit(status);
				await Promise.resolve();
				throw new Error("provider failed");
			},
		}),
	);
	expect((await events.next()).value).toEqual(status);
	await expect(events.next()).rejects.toThrow("provider failed");
});
