import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	Agent,
	BaseChatModel,
	ChatInvokeInput,
	RunEventStoreFactory,
	SessionRecord,
	SessionStateStore,
} from "@codelia/core";
import { Agent as CoreAgent } from "@codelia/core";
import type {
	AgentEventNotify,
	RpcMessage,
	RpcNotification,
	RpcRequest,
	RpcResponse,
	RunStartResult,
	RunStatusNotify,
} from "@codelia/protocol";
import { ensureStorageDirs, resolveStoragePaths } from "@codelia/storage";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { createHistoryHandlers } from "../src/rpc/history";
import {
	createTextDeltaCoalescer,
	type StreamDeltaEvent,
} from "../src/rpc/text-delta-coalescer";
import { RuntimeState } from "../src/runtime-state";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isRpcMessage = (value: unknown): value is RpcMessage =>
	isRecord(value) && value.jsonrpc === "2.0";

const waitFor = async (condition: () => boolean): Promise<void> => {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error("Timed out waiting for condition");
};

const createStdoutCapture = () => {
	const originalWrite = process.stdout.write.bind(process.stdout);
	let buffer = "";
	const messages: RpcMessage[] = [];
	const write = (chunk: string | Uint8Array): boolean => {
		buffer +=
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (line) {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (isRpcMessage(parsed)) messages.push(parsed);
				} catch {
					// ignore non-JSON output
				}
			}
			idx = buffer.indexOf("\n");
		}
		return true;
	};
	return {
		messages,
		start: () => {
			process.stdout.write = write;
		},
		stop: () => {
			process.stdout.write = originalWrite;
		},
	};
};

const agentEvents = (messages: RpcMessage[]): AgentEventNotify[] =>
	messages
		.filter(
			(msg): msg is RpcNotification =>
				"method" in msg && msg.method === "agent.event",
		)
		.map((msg) => msg.params as AgentEventNotify);

/** Two model steps: a tool call (unknown tool) with streamed text, then a terminal answer. */
class StreamingMockChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock-model";
	readonly sinkSeen: boolean[] = [];
	private step = 0;

	async ainvoke(
		input: ChatInvokeInput,
	): Promise<Awaited<ReturnType<BaseChatModel["ainvoke"]>>> {
		this.sinkSeen.push(typeof input.onDelta === "function");
		this.step += 1;
		if (this.step === 1) {
			input.onDelta?.({ kind: "reasoning", index: 0, delta: "thi" });
			input.onDelta?.({ kind: "reasoning", index: 0, delta: "nk" });
			input.onDelta?.({ kind: "text", index: 0, delta: "Look" });
			input.onDelta?.({ kind: "text", index: 0, delta: "ing" });
			return {
				messages: [
					{ role: "reasoning", content: "think" },
					{ role: "assistant", content: "Looking" },
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{
								id: "call_1",
								type: "function",
								function: { name: "missing_tool", arguments: "{}" },
							},
						],
					},
				],
			};
		}
		for (const delta of ["do", "n", "e"])
			input.onDelta?.({ kind: "text", index: 0, delta });
		return { messages: [{ role: "assistant", content: "done" }] };
	}
}

const createStores = (
	records: SessionRecord[],
): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: {
		create: () => ({
			append: (record) => {
				records.push(record);
			},
		}),
	},
	sessionStateStore: {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
	},
});

const runOnce = async (options: { supportsTextDelta: boolean }) => {
	const llm = new StreamingMockChatModel();
	const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
	const records: SessionRecord[] = [];
	const capture = createStdoutCapture();
	capture.start();
	try {
		const state = new RuntimeState();
		if (options.supportsTextDelta)
			state.setUiCapabilities({ supports_text_delta: true });
		const handlers = createRuntimeHandlers({
			state,
			getAgent: async () => agent,
			log: () => {},
			...createStores(records),
		});
		handlers.processMessage({
			jsonrpc: "2.0",
			id: "run-1",
			method: "run.start",
			params: { input: { type: "text", text: "hello" } },
		} satisfies RpcRequest);
		let runId = "";
		await waitFor(() => {
			const response = capture.messages.find(
				(msg): msg is RpcResponse => "id" in msg && msg.id === "run-1",
			);
			runId = (response?.result as RunStartResult | undefined)?.run_id ?? "";
			return runId.length > 0;
		});
		await waitFor(() =>
			capture.messages.some(
				(msg) =>
					"method" in msg &&
					msg.method === "run.status" &&
					(msg.params as RunStatusNotify).run_id === runId &&
					(msg.params as RunStatusNotify).status === "completed",
			),
		);
	} finally {
		capture.stop();
	}
	return { llm, records, events: agentEvents(capture.messages) };
};

const isDeltaType = (type: string): boolean =>
	type === "text.delta" || type === "reasoning.delta";

describe("text delta coalescer", () => {
	const manualTimers = () => {
		const callbacks: Array<() => void> = [];
		return {
			setTimer: (callback: () => void) => {
				callbacks.push(callback);
				return callbacks.length;
			},
			clearTimer: () => {},
			fire: () => {
				for (const callback of callbacks.splice(0)) callback();
			},
		};
	};
	const delta = (
		type: StreamDeltaEvent["type"],
		index: number,
		text: string,
		streamId = "s1",
	): StreamDeltaEvent => ({ type, delta: text, stream_id: streamId, index });

	test("merges consecutive same-key deltas and keeps cross-key order on timer flush", () => {
		const timers = manualTimers();
		const sent: StreamDeltaEvent[] = [];
		const coalescer = createTextDeltaCoalescer({
			send: (event) => sent.push(event),
			...timers,
		});
		coalescer.push(delta("reasoning.delta", 0, "a"));
		coalescer.push(delta("reasoning.delta", 0, "b"));
		coalescer.push(delta("text.delta", 0, "c"));
		coalescer.push(delta("text.delta", 1, "d"));
		coalescer.push(delta("text.delta", 1, "e"));
		coalescer.push(delta("text.delta", 1, "f", "s2"));
		expect(sent).toEqual([]);

		timers.fire();

		expect(sent).toEqual([
			delta("reasoning.delta", 0, "ab"),
			delta("text.delta", 0, "c"),
			delta("text.delta", 1, "de"),
			delta("text.delta", 1, "f", "s2"),
		]);
	});

	test("flush sends pending deltas immediately; dispose drops them", () => {
		const timers = manualTimers();
		const sent: StreamDeltaEvent[] = [];
		const coalescer = createTextDeltaCoalescer({
			send: (event) => sent.push(event),
			...timers,
		});
		coalescer.push(delta("text.delta", 0, "x"));
		coalescer.flush();
		expect(sent).toEqual([delta("text.delta", 0, "x")]);

		coalescer.push(delta("text.delta", 0, "dropped"));
		coalescer.dispose();
		timers.fire();
		coalescer.push(delta("text.delta", 0, "after"));
		coalescer.flush();
		expect(sent).toEqual([delta("text.delta", 0, "x")]);
	});
});

describe("run.start text deltas", () => {
	test("sends no deltas and passes no sink without supports_text_delta", async () => {
		const { llm, events } = await runOnce({ supportsTextDelta: false });

		expect(llm.sinkSeen).toEqual([false, false]);
		expect(events.some((entry) => isDeltaType(entry.event.type))).toBe(false);
		expect(events.at(-1)?.event).toEqual({ type: "final", content: "done" });
	});

	test("coalesces deltas, flushes them before the next event and never persists them", async () => {
		const baseline = await runOnce({ supportsTextDelta: false });
		const { llm, events, records } = await runOnce({ supportsTextDelta: true });

		expect(llm.sinkSeen).toEqual([true, true]);
		const types = events.map((entry) => entry.event.type);
		expect(types).toEqual([
			"reasoning.delta",
			"text.delta",
			"reasoning",
			"text",
			"step_start",
			"tool_call",
			"tool_result",
			"step_complete",
			"text.delta",
			"final",
		]);
		const deltas = events
			.map((entry) => entry.event)
			.filter((event) => isDeltaType(event.type)) as StreamDeltaEvent[];
		expect(
			deltas.map(({ type, delta, index }) => [type, delta, index]),
		).toEqual([
			["reasoning.delta", "think", 0],
			["text.delta", "Looking", 0],
			["text.delta", "done", 0],
		]);
		expect(deltas[0]?.stream_id).toBe(deltas[1]?.stream_id);
		expect(deltas[2]?.stream_id).not.toBe(deltas[0]?.stream_id);
		// seq stays contiguous and ordered on the wire.
		expect(events.map((entry) => entry.seq)).toEqual(
			events.map((_entry, index) => index),
		);

		// Persisted agent events are exactly the non-delta events, as without opt-in.
		const persisted = records.filter(
			(record): record is Extract<SessionRecord, { type: "agent.event" }> =>
				record.type === "agent.event",
		);
		expect(persisted.some((record) => isDeltaType(record.event.type))).toBe(
			false,
		);
		const strip = (types: string[]) => types.filter((t) => !isDeltaType(t));
		expect(persisted.map((record): string => record.event.type)).toEqual(
			strip(types),
		);
		expect(
			baseline.records
				.filter((record) => record.type === "agent.event")
				.map((record) => (record as { event: { type: string } }).event.type),
		).toEqual(strip(types));
	});

	test("session.history replays the persisted run without deltas", async () => {
		const { records } = await runOnce({ supportsTextDelta: true });
		const tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-text-delta-"),
		);
		const envKeys = [
			"CODELIA_LAYOUT",
			"XDG_STATE_HOME",
			"XDG_CACHE_HOME",
			"XDG_CONFIG_HOME",
		];
		const snapshot = new Map(envKeys.map((key) => [key, process.env[key]]));
		process.env.CODELIA_LAYOUT = "xdg";
		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		process.env.XDG_CONFIG_HOME = path.join(tempRoot, "config");
		const capture = createStdoutCapture();
		try {
			const paths = resolveStoragePaths();
			await ensureStorageDirs(paths);
			const header = records.find((record) => record.type === "header") as
				| Extract<SessionRecord, { type: "header" }>
				| undefined;
			if (!header) throw new Error("missing header record");
			const runDir = path.join(paths.sessionsDir, "2026", "02", "08");
			await fs.mkdir(runDir, { recursive: true });
			// A delta record that some other writer persisted is still skipped.
			const injected = {
				type: "agent.event",
				run_id: header.run_id,
				ts: header.started_at,
				seq: 999,
				event: { type: "text.delta", delta: "x", stream_id: "s", index: 0 },
			};
			await fs.writeFile(
				path.join(runDir, `${header.run_id}.jsonl`),
				`${[...records, injected].map((record) => JSON.stringify(record)).join("\n")}\n`,
				"utf8",
			);
			const { handleSessionHistory } = createHistoryHandlers({
				sessionStateStore: createStores([]).sessionStateStore,
				log: () => {},
			});
			capture.start();
			await handleSessionHistory("history-1", {
				session_id: header.session_id ?? "",
				max_runs: 5,
				max_events: 100,
			});
		} finally {
			capture.stop();
			for (const [key, value] of snapshot) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}

		const replayed = agentEvents(capture.messages).map(
			(entry) => entry.event.type,
		);
		expect(replayed).toContain("final");
		expect(replayed.some(isDeltaType)).toBe(false);
	});
	test("run.cancel drops pending batched deltas", async () => {
		let markEmitted: () => void = () => {};
		const emitted = new Promise<void>((resolve) => {
			markEmitted = resolve;
		});
		const llm: BaseChatModel = {
			provider: "openai",
			model: "mock-model",
			ainvoke: (input) =>
				new Promise((_resolve, reject) => {
					input.onDelta?.({ kind: "text", index: 0, delta: "partial" });
					markEmitted();
					input.signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		};
		const agent = new CoreAgent({ llm, tools: [] }) as unknown as Agent;
		const capture = createStdoutCapture();
		capture.start();
		try {
			const state = new RuntimeState();
			state.setUiCapabilities({ supports_text_delta: true });
			const handlers = createRuntimeHandlers({
				state,
				getAgent: async () => agent,
				log: () => {},
				...createStores([]),
			});
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "run-cancel",
				method: "run.start",
				params: { input: { type: "text", text: "hello" } },
			} satisfies RpcRequest);
			let runId = "";
			await waitFor(() => {
				const response = capture.messages.find(
					(msg): msg is RpcResponse => "id" in msg && msg.id === "run-cancel",
				);
				runId = (response?.result as RunStartResult | undefined)?.run_id ?? "";
				return runId.length > 0;
			});
			await emitted;
			await Bun.sleep(0);
			handlers.processMessage({
				jsonrpc: "2.0",
				id: "cancel-1",
				method: "run.cancel",
				params: { run_id: runId, reason: "test" },
			} satisfies RpcRequest);
			await waitFor(() =>
				capture.messages.some(
					(msg) =>
						"method" in msg &&
						msg.method === "run.status" &&
						(msg.params as RunStatusNotify).status === "cancelled",
				),
			);
			// Outlast the coalescing window: the dropped batch must never be sent.
			await Bun.sleep(100);
		} finally {
			capture.stop();
		}

		expect(
			agentEvents(capture.messages).some((entry) =>
				isDeltaType(entry.event.type),
			),
		).toBe(false);
	});
});
