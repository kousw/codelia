import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Agent, type PolledMessage } from "../src/agent/agent";
import type {
	BaseChatModel,
	ChatInvokeContext,
	ChatInvokeInput,
} from "../src/llm/base";
import { defineTool } from "../src/tools/define";
import type { AgentEvent } from "../src/types/events/agent-events";
import type { ContentPart } from "../src/types/llm/content";
import type { ChatInvokeCompletion } from "../src/types/llm/invoke";
import type { ToolCall } from "../src/types/llm/tools";

class ScriptedChatModel implements BaseChatModel {
	readonly provider = "openai" as const;
	readonly model = "mock";
	private readonly script: Array<
		ChatInvokeCompletion | ((input: ChatInvokeInput) => ChatInvokeCompletion)
	>;
	readonly calls: ChatInvokeInput[] = [];

	constructor(
		script: Array<
			ChatInvokeCompletion | ((input: ChatInvokeInput) => ChatInvokeCompletion)
		>,
	) {
		this.script = [...script];
	}

	async ainvoke(
		input: ChatInvokeInput,
		_context?: ChatInvokeContext,
	): Promise<ChatInvokeCompletion> {
		this.calls.push(input);
		const next = this.script.shift();
		if (!next) {
			throw new Error("ScriptedChatModel: no scripted response available");
		}
		return typeof next === "function" ? next(input) : next;
	}
}

const toolCall = (id: string, name: string, args: string): ToolCall => ({
	id,
	type: "function",
	function: { name, arguments: args },
});

const assistantResponse = (
	content: string | null,
	toolCalls: ToolCall[] = [],
): ChatInvokeCompletion => ({
	messages: [
		{
			role: "assistant",
			content,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		},
	],
});

describe("Agent mid-run steer", () => {
	test("delivers steer at iteration boundary without interrupting a tool batch", async () => {
		const executionLog: string[] = [];
		const inbox: PolledMessage[] = [];
		let pollCount = 0;

		const echoTool = defineTool({
			name: "echo",
			description: "Record execution order",
			input: z.object({ label: z.string() }),
			execute: ({ label }) => {
				executionLog.push(`tool:${label}`);
				if (label === "first") {
					inbox.push({
						kind: "steer",
						steer_id: "steer-1",
						content: "change direction",
					});
				}
				return `ok:${label}`;
			},
		});

		const llm = new ScriptedChatModel([
			assistantResponse(null, [
				toolCall("call_1", "echo", '{"label":"first"}'),
				toolCall("call_2", "echo", '{"label":"second"}'),
			]),
			(input) => {
				const lastMessage = input.messages.at(-1);
				return assistantResponse(
					`after steer:${typeof lastMessage?.content === "string" ? lastMessage.content : ""}`,
				);
			},
		]);

		const agent = new Agent({ llm, tools: [echoTool] });
		const events: AgentEvent[] = [];

		for await (const event of agent.runStream("initial", {
			pollMessages: async () => {
				pollCount += 1;
				const drained = inbox.splice(0, inbox.length);
				if (drained.length > 0) {
					executionLog.push(
						...drained.map((entry) =>
							typeof entry === "string" ? entry : `steer:${entry.steer_id}`,
						),
					);
				}
				return drained;
			},
		})) {
			events.push(event);
		}

		// Both tools in the batch finish before the steer is polled for the next step.
		expect(executionLog).toEqual([
			"tool:first",
			"tool:second",
			"steer:steer-1",
		]);
		expect(pollCount).toBeGreaterThanOrEqual(2);
		const steerIndex = events.findIndex(
			(event) => event.type === "steer_applied",
		);
		const secondToolCompleteIndex = events.findIndex(
			(event) => event.type === "step_complete" && event.step_id === "call_2",
		);
		expect(secondToolCompleteIndex).toBeGreaterThanOrEqual(0);
		expect(steerIndex).toBeGreaterThan(secondToolCompleteIndex);
		expect(events[steerIndex]).toMatchObject({
			type: "steer_applied",
			steer_id: "steer-1",
			content: "change direction",
		});
		expect(events.at(-1)).toEqual({
			type: "final",
			content: "after steer:change direction",
		});
	});

	test("flushes intermediate assistant text before steer_applied on pre-final boundary", async () => {
		const inbox: PolledMessage[] = [];
		let callNumber = 0;

		const llm = new ScriptedChatModel([
			() => {
				callNumber += 1;
				// Queue steer while model produced a text-only response that would otherwise be final.
				inbox.push({
					kind: "steer",
					steer_id: "steer-prefinal",
					content: "wait, also check B",
				});
				return assistantResponse("first draft");
			},
			assistantResponse("updated final"),
		]);

		const agent = new Agent({ llm, tools: [] });
		const events: AgentEvent[] = [];

		for await (const event of agent.runStream("start", {
			pollMessages: async () => inbox.splice(0, inbox.length),
		})) {
			events.push(event);
		}

		expect(callNumber).toBe(1);
		expect(llm.calls).toHaveLength(2);
		expect(llm.calls[1]?.messages.at(-1)).toEqual({
			role: "user",
			content: "wait, also check B",
		});
		const textIndex = events.findIndex(
			(event) => event.type === "text" && event.content === "first draft",
		);
		const steerIndex = events.findIndex(
			(event) => event.type === "steer_applied",
		);
		const finalEvents = events.filter((event) => event.type === "final");

		expect(textIndex).toBeGreaterThanOrEqual(0);
		expect(steerIndex).toBeGreaterThan(textIndex);
		expect(events[steerIndex]).toMatchObject({
			type: "steer_applied",
			steer_id: "steer-prefinal",
			content: "wait, also check B",
		});
		expect(finalEvents).toEqual([{ type: "final", content: "updated final" }]);
	});

	test("preserves ContentPart[] steers and FIFO ordering", async () => {
		const parts: ContentPart[] = [
			{ type: "text", text: "inspect screenshot" },
			{
				type: "image_url",
				image_url: { url: "data:image/png;base64,AAAA", detail: "auto" },
			},
		];
		const inbox: PolledMessage[] = [];
		let seeded = false;

		const stepTool = defineTool({
			name: "ping",
			description: "Ping",
			input: z.object({}),
			execute: () => {
				if (!seeded) {
					seeded = true;
					inbox.push(
						{ kind: "steer", steer_id: "s1", content: "first steer" },
						{ kind: "steer", steer_id: "s2", content: parts },
					);
				}
				return "pong";
			},
		});

		const llm = new ScriptedChatModel([
			assistantResponse(null, [toolCall("call_1", "ping", "{}")]),
			assistantResponse("done"),
		]);

		const agent = new Agent({ llm, tools: [stepTool] });
		const events: AgentEvent[] = [];

		for await (const event of agent.runStream("hi", {
			pollMessages: async () => inbox.splice(0, inbox.length),
		})) {
			events.push(event);
		}

		const steerEvents = events.filter(
			(event): event is Extract<AgentEvent, { type: "steer_applied" }> =>
				event.type === "steer_applied",
		);
		expect(steerEvents).toHaveLength(2);
		expect(steerEvents[0]).toMatchObject({
			steer_id: "s1",
			content: "first steer",
		});
		expect(steerEvents[1]).toMatchObject({
			steer_id: "s2",
			content: parts,
		});
		const secondCallMessages = llm.calls[1]?.messages ?? [];
		expect(secondCallMessages.at(-2)).toEqual({
			role: "user",
			content: "first steer",
		});
		expect(secondCallMessages.at(-1)).toEqual({
			role: "user",
			content: parts,
		});
	});

	test("forceCompaction does not poll steers", async () => {
		let pollCalled = false;
		const llm = new ScriptedChatModel([assistantResponse("unused")]);
		const agent = new Agent({ llm, tools: [] });
		const events: AgentEvent[] = [];

		for await (const event of agent.runStream("compact", {
			forceCompaction: true,
			pollMessages: async () => {
				pollCalled = true;
				return [{ kind: "steer", steer_id: "s-ignored", content: "hi" }];
			},
		})) {
			events.push(event);
		}

		expect(pollCalled).toBe(false);
		expect(events.some((event) => event.type === "steer_applied")).toBe(false);
		expect(events.at(-1)).toEqual({
			type: "final",
			content: "Compaction run completed.",
		});
	});

	test("abort during session.recordMessages after polling steer prevents history enqueue and steer_applied", async () => {
		const controller = new AbortController();
		const inbox: PolledMessage[] = [];
		const pingTool = defineTool({
			name: "ping",
			description: "Ping",
			input: z.object({}),
			execute: () => {
				inbox.push({
					kind: "steer",
					steer_id: "steer-abort",
					content: "steer after tool",
				});
				return "pong";
			},
		});

		const llm = new ScriptedChatModel([
			assistantResponse(null, [toolCall("call_1", "ping", "{}")]),
			assistantResponse("should not reach second call"),
		]);

		const agent = new Agent({ llm, tools: [pingTool] });
		const events: AgentEvent[] = [];
		let caught: unknown = null;

		try {
			for await (const event of agent.runStream("initial", {
				signal: controller.signal,
				session: {
					run_id: "run-abort-record",
					session_id: "sess-abort-record",
					append: () => {},
					recordMessages: async (messages) => {
						if (
							messages.some(
								(msg) =>
									msg.role === "user" && msg.content === "steer after tool",
							)
						) {
							controller.abort();
						}
					},
				},
				pollMessages: async () => inbox.splice(0, inbox.length),
			})) {
				events.push(event);
			}
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).name).toBe("AbortError");
		expect(events.some((event) => event.type === "steer_applied")).toBe(false);
		expect(
			agent
				.getHistoryMessages()
				.some(
					(msg) => msg.role === "user" && msg.content === "steer after tool",
				),
		).toBe(false);
		expect(llm.calls).toHaveLength(1);
	});
});
