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

const textDelta = (delta: string, index = 0) => ({
	type: "text.delta" as const,
	delta,
	stream_id: "s1",
	index,
});

test("a failure while the consumer is still handling queued deltas reaches the caller, not unhandledRejection", async () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const events = withProviderStatus((emit, signal) =>
			invokeWithRetry({
				policy: resolveLlmRetryPolicy({ maxRetries: 0 }),
				signal,
				operation: async () => {
					for (const part of ["a", "b", "c", "d"]) emit(textDelta(part));
					await Bun.sleep(1);
					throw new Error("provider failed mid-stream");
				},
			}),
		);
		const received: string[] = [];
		let caught: unknown;
		try {
			for await (const event of events) {
				if (event.type === "text.delta") received.push(event.delta);
				await Bun.sleep(15);
			}
		} catch (error) {
			caught = error;
		}
		await Bun.sleep(5);
		expect(String(caught)).toContain("provider failed mid-stream");
		expect(received.join("")).toBe("abcd");
		expect(unhandled).toEqual([]);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("deltas queued for a slow consumer merge per (type, stream_id, index) without losing text", async () => {
	const parts = Array.from({ length: 10_000 }, (_, i) => `${i % 10}`);
	const events = withProviderStatus((emit, signal) =>
		invokeWithRetry({
			policy: resolveLlmRetryPolicy({ maxRetries: 0 }),
			signal,
			operation: async () => {
				for (const part of parts) emit(textDelta(part, 0));
				emit({
					type: "reasoning.delta",
					delta: "r",
					stream_id: "s1",
					index: 0,
				});
				emit(textDelta("x", 1));
				emit(textDelta("y", 1));
				await Bun.sleep(1);
				return "done";
			},
		}),
	);
	const received: Array<{ type: string; index: number; delta: string }> = [];
	let result: unknown;
	while (true) {
		const next = await events.next();
		if (next.done) {
			result = next.value;
			break;
		}
		const event = next.value;
		if (event.type === "text.delta" || event.type === "reasoning.delta")
			received.push({
				type: event.type,
				index: event.index,
				delta: event.delta,
			});
		await Bun.sleep(5);
	}
	expect(result).toBe("done");
	expect(received).toEqual([
		{ type: "text.delta", index: 0, delta: parts.join("") },
		{ type: "reasoning.delta", index: 0, delta: "r" },
		{ type: "text.delta", index: 1, delta: "xy" },
	]);
});
