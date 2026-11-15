import { describe, expect, test } from "bun:test";
import type {
	BaseChatModel,
	ChatInvokeInput,
	RunEventStoreFactory,
	SessionStateStore,
} from "@codelia/core";
import { Agent } from "@codelia/core";
import type { RpcMessage, RunStartResult } from "@codelia/protocol";
import { createRuntimeHandlers } from "../src/rpc/handlers";
import { RuntimeState } from "../src/runtime-state";

class TwoStepModel implements BaseChatModel {
	readonly provider = "anthropic" as const;
	readonly model = "claude-opus-5";
	private calls = 0;
	async ainvoke(_input: ChatInvokeInput) {
		this.calls += 1;
		const first = this.calls % 2 === 1;
		return {
			messages: [
				first
					? {
							role: "assistant" as const,
							content: null,
							tool_calls: [
								{
									id: `call-${this.calls}`,
									type: "function" as const,
									function: { name: "missing_tool", arguments: "{}" },
								},
							],
						}
					: { role: "assistant" as const, content: "done" },
			],
			usage: {
				model: "claude-opus-5",
				input_tokens: first ? 100 : 400,
				output_tokens: 10,
				total_tokens: first ? 110 : 410,
			},
		};
	}
}

const stores = (): {
	runEventStoreFactory: RunEventStoreFactory;
	sessionStateStore: SessionStateStore;
} => ({
	runEventStoreFactory: { create: () => ({ append: () => {} }) },
	sessionStateStore: {
		load: async () => null,
		save: async () => undefined,
		list: async () => [],
	},
});

type Message = {
	id?: string;
	method?: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: { code: number };
};

const harness = (state: RuntimeState, agent: Agent | null) => {
	const messages: Message[] = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		for (const line of String(chunk).split("\n")) {
			if (line.trim()) messages.push(JSON.parse(line) as RpcMessage as Message);
		}
		return true;
	}) as typeof process.stdout.write;
	const handlers = createRuntimeHandlers({
		state,
		log: () => {},
		getAgent: async () => {
			if (!agent) throw new Error("no agent");
			state.agent = agent;
			return agent;
		},
		...stores(),
	});
	const waitFor = async (predicate: (message: Message) => boolean) => {
		const deadline = Date.now() + 5000;
		for (;;) {
			const found = messages.find(predicate);
			if (found) return found;
			if (Date.now() > deadline) throw new Error("timed out");
			await Bun.sleep(5);
		}
	};
	return {
		messages,
		restore: () => {
			process.stdout.write = write;
		},
		request: async (id: string, method: string, params?: unknown) => {
			handlers.processMessage({ jsonrpc: "2.0", id, method, params });
			return waitFor((message) => message.id === id && !message.method);
		},
		waitForRunEnd: (runId: string) =>
			waitFor(
				(message) =>
					message.method === "run.status" &&
					message.params?.run_id === runId &&
					message.params?.status === "completed",
			),
	};
};

describe("context usage RPC", () => {
	test("context.usage answers without building an agent", async () => {
		const state = new RuntimeState();
		state.currentModelProvider = "anthropic";
		state.currentModelName = "claude-opus-5";
		const rpc = harness(state, null);
		try {
			const response = await rpc.request("u1", "context.usage", {});
			expect(response.result).toEqual({
				provider: "anthropic",
				model: "claude-opus-5",
				limit_tokens: null,
				used_tokens: null,
				input_tokens: null,
				left_percent: null,
				basis: "none",
				breakdown: [],
			});
			expect(state.agent).toBeNull();
		} finally {
			rpc.restore();
		}
	});

	test("opted-in clients get one run.context.usage per model call; others get none", async () => {
		for (const optIn of [true, false]) {
			const state = new RuntimeState();
			state.setUiCapabilities({ supports_context_usage: optIn });
			const agent = new Agent({
				llm: new TwoStepModel(),
				tools: [],
				systemPrompt: "system prompt",
			});
			const rpc = harness(state, agent);
			try {
				const started = await rpc.request("run", "run.start", {
					input: { type: "text", text: "hello" },
				});
				const runId = (started.result as RunStartResult).run_id;
				await rpc.waitForRunEnd(runId);
				const notes = rpc.messages.filter(
					(message) => message.method === "run.context.usage",
				);
				if (!optIn) {
					expect(notes).toHaveLength(0);
					continue;
				}
				expect(notes.map((note) => note.params?.used_tokens)).toEqual([
					110, 410,
				]);
				expect(notes[1]?.params).toMatchObject({
					run_id: runId,
					provider: "anthropic",
					model: "claude-opus-5",
					input_tokens: 400,
					basis: "provider",
				});
				expect(typeof notes[1]?.params?.limit_tokens).toBe("number");
				const usage = await rpc.request("u2", "context.usage");
				expect(usage.result).toMatchObject({
					used_tokens: 410,
					basis: "provider",
					session_id: started.result?.session_id ?? state.sessionId,
				});
				const categories = (
					(usage.result?.breakdown ?? []) as Array<{ category: string }>
				).map((entry) => entry.category);
				expect(categories).toEqual([
					"system",
					"tools",
					"messages",
					"tool_results",
					"images",
				]);
			} finally {
				rpc.restore();
			}
		}
	});
});
