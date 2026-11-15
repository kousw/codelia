import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent } from "../src/agent/agent";
import type {
	BaseChatModel,
	ChatInvokeInput,
	ChatStreamDelta,
	ChatStreamDeltaSink,
} from "../src/llm/base";
import { buildProviderFailure } from "../src/llm/failures";
import { defineTool } from "../src/tools/define";
import type { AgentEvent } from "../src/types/events";
import type { ChatInvokeCompletion } from "../src/types/llm/invoke";

type ScriptStep = {
	deltas: ChatStreamDelta[];
	result: ChatInvokeCompletion | Error;
};

class StreamingMockChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock";
	readonly sinks: Array<ChatStreamDeltaSink | undefined> = [];
	private readonly script: ScriptStep[];

	constructor(
		script: ScriptStep[],
		readonly classifyFailure?: BaseChatModel["classifyFailure"],
	) {
		this.script = [...script];
	}

	async ainvoke(input: ChatInvokeInput): Promise<ChatInvokeCompletion> {
		this.sinks.push(input.onDelta);
		const step = this.script.shift();
		if (!step) throw new Error("no scripted response");
		for (const delta of step.deltas) {
			// Emit asynchronously so deltas arrive while the call is in flight.
			await Bun.sleep(0);
			input.onDelta?.(delta);
		}
		if (step.result instanceof Error) throw step.result;
		return step.result;
	}
}

const echoTool = defineTool({
	name: "echo",
	description: "Echo",
	input: z.object({ value: z.string() }),
	execute: ({ value }) => `echo:${value}`,
});

const toolStepScript = (): ScriptStep[] => [
	{
		deltas: [
			{ kind: "reasoning", index: 0, delta: "Think" },
			{ kind: "reasoning", index: 0, delta: "ing" },
			{ kind: "text", index: 0, delta: "Let me " },
			{ kind: "text", index: 0, delta: "check" },
			{ kind: "text", index: 1, delta: "Second" },
		],
		result: {
			messages: [
				{ role: "reasoning", content: "Thinking" },
				{ role: "assistant", content: "Let me check" },
				{ role: "assistant", content: "Second" },
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: { name: "echo", arguments: '{"value":"x"}' },
						},
					],
				},
			],
		},
	},
	{
		deltas: [
			{ kind: "text", index: 0, delta: "do" },
			{ kind: "text", index: 0, delta: "ne" },
		],
		result: { messages: [{ role: "assistant", content: "done" }] },
	},
];

const collect = async (
	agent: Agent,
	streamDeltas?: boolean,
): Promise<AgentEvent[]> => {
	const events: AgentEvent[] = [];
	for await (const event of agent.runStream("hi", {
		...(streamDeltas !== undefined ? { streamDeltas } : {}),
	}))
		events.push(event);
	return events;
};

const isDelta = (event: AgentEvent): boolean =>
	event.type === "text.delta" || event.type === "reasoning.delta";

const stripTimestamps = (events: AgentEvent[]): unknown[] =>
	events.map((event) => {
		if ("timestamp" in event) return { ...event, timestamp: 0 };
		if (event.type === "step_complete") return { ...event, duration_ms: 0 };
		return event;
	});

describe("Agent stream deltas", () => {
	test("without opt-in no sink is passed and no delta events are yielded", async () => {
		const llm = new StreamingMockChatModel(toolStepScript());
		const events = await collect(new Agent({ llm, tools: [echoTool] }));

		expect(llm.sinks).toEqual([undefined, undefined]);
		expect(events.some(isDelta)).toBe(false);
	});

	test("yields ordered deltas per attempt and leaves complete events unchanged", async () => {
		const baselineEvents = await collect(
			new Agent({
				llm: new StreamingMockChatModel(toolStepScript()),
				tools: [echoTool],
			}),
		);
		const llm = new StreamingMockChatModel(toolStepScript());
		const events = await collect(new Agent({ llm, tools: [echoTool] }), true);

		expect(stripTimestamps(events.filter((e) => !isDelta(e)))).toEqual(
			stripTimestamps(baselineEvents),
		);

		const deltas = events.filter(isDelta) as Array<
			Extract<AgentEvent, { type: "text.delta" | "reasoning.delta" }>
		>;
		const [firstStream, secondStream] = [
			deltas[0]?.stream_id,
			deltas.at(-1)?.stream_id,
		];
		expect(typeof firstStream).toBe("string");
		expect(firstStream).not.toBe(secondStream);
		expect(
			deltas.map(({ type, index, delta, stream_id }) => [
				type,
				index,
				delta,
				stream_id === firstStream ? 1 : 2,
			]),
		).toEqual([
			["reasoning.delta", 0, "Think", 1],
			["reasoning.delta", 0, "ing", 1],
			["text.delta", 0, "Let me ", 1],
			["text.delta", 0, "check", 1],
			["text.delta", 1, "Second", 1],
			["text.delta", 0, "do", 2],
			["text.delta", 0, "ne", 2],
		]);

		// Deltas of a step precede that step's complete events.
		const types = events.map((event) => event.type);
		expect(types.indexOf("reasoning")).toBeGreaterThan(
			types.indexOf("text.delta"),
		);
		expect(types.lastIndexOf("text.delta")).toBeLessThan(
			types.indexOf("final"),
		);
		expect(types.lastIndexOf("text.delta")).toBeGreaterThan(
			types.indexOf("tool_result"),
		);

		// Concatenated deltas per (stream_id, index) equal the complete texts.
		const textByBlock = new Map<string, string>();
		for (const delta of deltas.filter((d) => d.type === "text.delta")) {
			const key = `${delta.stream_id}:${delta.index}`;
			textByBlock.set(key, (textByBlock.get(key) ?? "") + delta.delta);
		}
		expect([...textByBlock.values()]).toEqual([
			"Let me check",
			"Second",
			"done",
		]);
		expect(events.filter((e) => e.type === "text")).toEqual([
			expect.objectContaining({ content: "Let me check" }),
			expect.objectContaining({ content: "Second" }),
		]);
		expect(events.at(-1)).toEqual({ type: "final", content: "done" });
	});

	test("a retried attempt gets a new stream_id after the llm.retry event", async () => {
		const llm = new StreamingMockChatModel(
			[
				{
					deltas: [{ kind: "text", index: 0, delta: "partial" }],
					result: new Error("stream dropped"),
				},
				{
					deltas: [{ kind: "text", index: 0, delta: "full answer" }],
					result: { messages: [{ role: "assistant", content: "full answer" }] },
				},
			],
			() =>
				buildProviderFailure("openai", "overloaded", {
					retryable: true,
					retryAfterMs: 1,
					delaySource: "retry-after",
				}),
		);
		const agent = new Agent({
			llm,
			tools: [],
			services: { llmRetryNowMs: () => 0, llmRetrySleep: async () => {} },
		});
		const events = await collect(agent, true);

		expect(events.map((event) => event.type)).toEqual([
			"text.delta",
			"llm.retry",
			"text.delta",
			"final",
		]);
		const first = events[0] as Extract<AgentEvent, { type: "text.delta" }>;
		const second = events[2] as Extract<AgentEvent, { type: "text.delta" }>;
		expect(first.delta).toBe("partial");
		expect(second.delta).toBe("full answer");
		expect(first.stream_id).not.toBe(second.stream_id);
		expect(events.at(-1)).toEqual({ type: "final", content: "full answer" });
	});

	test("ignores deltas a provider emits after its attempt settled", async () => {
		let lateSink: ChatStreamDeltaSink | undefined;
		const llm: BaseChatModel = {
			provider: "openai",
			model: "mock",
			ainvoke: async (input) => {
				lateSink = input.onDelta;
				input.onDelta?.({ kind: "text", index: 0, delta: "ok" });
				return { messages: [{ role: "assistant", content: "ok" }] };
			},
		};
		const events: AgentEvent[] = [];
		for await (const event of new Agent({ llm, tools: [] }).runStream("hi", {
			streamDeltas: true,
		})) {
			lateSink?.({ kind: "text", index: 0, delta: "late" });
			events.push(event);
		}

		expect(events.filter(isDelta)).toEqual([
			expect.objectContaining({ type: "text.delta", delta: "ok" }),
		]);
	});

	test("a consumer that stops mid-attempt does not leak the failure of that attempt", async () => {
		let calls = 0;
		let failAttempt: (error: Error) => void = () => {};
		const llm: BaseChatModel = {
			provider: "openai",
			model: "mock",
			classifyFailure: () =>
				buildProviderFailure("openai", "overloaded", {
					retryable: false,
				}),
			ainvoke: (input) => {
				calls += 1;
				input.onDelta?.({ kind: "text", index: 0, delta: "partial" });
				return new Promise((_, reject) => {
					failAttempt = reject;
				});
			},
		};

		const seen: AgentEvent[] = [];
		for await (const event of new Agent({ llm, tools: [] }).runStream("hi", {
			streamDeltas: true,
		})) {
			seen.push(event);
			if (isDelta(event)) break;
		}
		// The attempt fails terminally only after the consumer has gone; that
		// rejection must not surface as an unhandled rejection.
		failAttempt(new Error("stream reset"));
		await Bun.sleep(20);

		expect(seen.filter(isDelta)).toHaveLength(1);
		expect(calls).toBe(1);
	});

	test("a failure while a slow consumer is still reading deltas reaches the caller's catch", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const llm: BaseChatModel = {
				provider: "openai",
				model: "mock",
				classifyFailure: () =>
					buildProviderFailure("openai", "overloaded", {
						retryable: false,
					}),
				ainvoke: async (input) => {
					for (const delta of ["a", "b", "c", "d"])
						input.onDelta?.({ kind: "text", index: 0, delta });
					await Bun.sleep(1);
					throw new Error("stream reset");
				},
			};
			const deltas: string[] = [];
			let caught: unknown;
			try {
				for await (const event of new Agent({ llm, tools: [] }).runStream(
					"hi",
					{ streamDeltas: true },
				)) {
					if (event.type === "text.delta") deltas.push(event.delta);
					await Bun.sleep(15);
				}
			} catch (error) {
				caught = error;
			}
			await Bun.sleep(5);
			expect(caught).toBeDefined();
			// Queued deltas of the busy consumer were merged into one event.
			expect(deltas).toEqual(["abcd"]);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
