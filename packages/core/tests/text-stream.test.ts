import { expect, test } from "bun:test";
import { Agent } from "../src/agent/agent";
import type { BaseChatModel } from "../src/llm/base";
import { buildProviderFailure } from "../src/llm/failures";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const completion = (content: string) => ({
	messages: [{ role: "assistant" as const, content }],
});
const agent = (llm: BaseChatModel) =>
	new Agent({
		llm,
		tools: [],
		compaction: null,
		toolOutputCache: null,
		llmMaxRetries: 1,
		llmRetryBaseDelayMs: 0,
		llmRetryMaxDelayMs: 0,
	});

test("text arrives before completion, canonical answer alone enters history, legacy callers stay buffered", async () => {
	const release = deferred();
	let invokeSignal: AbortSignal | undefined;
	const model: BaseChatModel = {
		provider: "openai",
		model: "mock",
		async ainvoke(input, context) {
			invokeSignal = input.signal;
			await context?.onTextDelta?.("日本語の部分");
			await release.promise;
			return completion("日本語の確定応答");
		},
	};
	const a = agent(model),
		stream = a.runStream("hello", { streamText: true });
	expect((await stream.next()).value).toMatchObject({
		type: "text.stream",
		phase: "start",
	});
	expect((await stream.next()).value).toMatchObject({
		type: "text.stream",
		phase: "delta",
		offset: 0,
		content: "日本語の部分",
	});
	expect(a.getHistoryMessages().some((m) => m.role === "assistant")).toBe(
		false,
	);
	release.resolve();
	const remaining = [];
	for await (const e of stream) remaining.push(e);
	expect(remaining.filter((e) => e.type === "text.stream")).toMatchObject([
		{ phase: "commit", content: "日本語の確定応答" },
	]);
	expect(
		a.getHistoryMessages().filter((m) => m.role === "assistant"),
	).toMatchObject([{ content: "日本語の確定応答" }]);
	expect(invokeSignal?.aborted).toBe(false);
	const legacy = [];
	for await (const e of agent(model).runStream("legacy")) legacy.push(e);
	expect(legacy.map((e) => e.type)).toEqual(["final"]);
});

test("retry discards the failed attempt before another starts and commits only successful history", async () => {
	let attempts = 0;
	const llm: BaseChatModel = {
		provider: "openai",
		model: "mock",
		classifyFailure: () =>
			buildProviderFailure("openai", "network", { retryable: true }),
		async ainvoke(_, context) {
			attempts++;
			await context?.onTextDelta?.(
				attempts === 1 ? "failed partial" : "winning partial",
			);
			if (attempts === 1) throw new Error("transport failed");
			return completion("canonical winner");
		},
	};
	const a = agent(llm),
		events = [];
	for await (const e of a.runStream("hello", { streamText: true }))
		events.push(e);
	const streams = events.filter((e) => e.type === "text.stream");
	expect(streams.map((e) => e.phase)).toEqual([
		"start",
		"delta",
		"discard",
		"start",
		"delta",
		"commit",
	]);
	expect(streams[0]?.stream_id).not.toBe(streams[3]?.stream_id);
	expect(streams[0]?.invocation_id).toBe(streams[3]?.invocation_id);
	expect(events.map((e) => e.type)).toContain("llm.retry");
	expect(JSON.stringify(a.getHistoryMessages())).not.toContain(
		"failed partial",
	);
	expect(
		a.getHistoryMessages().filter((m) => m.role === "assistant"),
	).toMatchObject([{ content: "canonical winner" }]);
});

test("cancellation drops partial text, rejects completion and never commits assistant history", async () => {
	const abort = new AbortController();
	let modelAborted = false;
	const llm: BaseChatModel = {
		provider: "openai",
		model: "mock",
		async ainvoke(input, context) {
			await context?.onTextDelta?.("unfinished");
			return await new Promise((_, reject) => {
				const stop = () => {
					modelAborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				};
				if (input.signal?.aborted) stop();
				else input.signal?.addEventListener("abort", stop, { once: true });
			});
		},
	};
	const a = agent(llm),
		stream = a.runStream("hello", { signal: abort.signal, streamText: true });
	await stream.next();
	await stream.next();
	abort.abort();
	expect((await stream.next()).value).toMatchObject({
		type: "text.stream",
		phase: "discard",
	});
	await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
	expect(modelAborted).toBe(true);
	expect(a.getHistoryMessages().some((m) => m.role === "assistant")).toBe(
		false,
	);
});

test("returning a slow consumer releases the awaiting provider without an unhandled rejection", async () => {
	let abandoned = false;
	const finished = deferred();
	const llm: BaseChatModel = {
		provider: "openai",
		model: "mock",
		async ainvoke(_, context) {
			try {
				await context?.onTextDelta?.("unfinished");
				return completion("unexpected");
			} catch (error) {
				abandoned = true;
				throw error;
			} finally {
				finished.resolve();
			}
		},
	};
	const stream = agent(llm).runStream("hello", { streamText: true });
	await stream.next();
	await stream.next();
	await stream.return(undefined);
	await finished.promise;
	expect(abandoned).toBe(true);
});

test("large Japanese deltas have bounded chunks and UTF-8 offsets, canonical completion is preserved", async () => {
	const text = "日本語🌸".repeat(250000);
	const llm: BaseChatModel = {
		provider: "openai",
		model: "mock",
		async ainvoke(_, context) {
			await context?.onTextDelta?.(text);
			return completion("bounded canonical result");
		},
	};
	let offset = 0,
		deltaCount = 0;
	for await (const event of agent(llm).runStream("hello", {
		streamText: true,
	})) {
		if (event.type === "text.stream" && event.phase === "delta") {
			expect(event.offset).toBe(offset);
			expect(Buffer.byteLength(event.content)).toBeLessThanOrEqual(16384);
			expect(event.content).not.toContain("�");
			offset += Buffer.byteLength(event.content);
			deltaCount++;
		}
		if (event.type === "text.stream" && event.phase === "commit")
			expect(event.content).toBe("bounded canonical result");
	}
	expect(deltaCount).toBeGreaterThan(1);
	expect(offset).toBeLessThanOrEqual(2 * 1024 * 1024);
});
