import { expect, spyOn, test } from "bun:test";
import { Agent, type BaseChatModel, type BaseMessage } from "@codelia/core";
import type { RunStartParams } from "@codelia/protocol";
import { createRunHandlers } from "../src/rpc/run";
import { RuntimeState } from "../src/runtime-state";
import { VolatileSessionStateStore } from "../src/volatile-stores";

test("explicit new session isolates history and identity; resume still restores the first thread", async () => {
	const seen: BaseMessage[][] = [];
	const model: BaseChatModel = {
		provider: "openai",
		model: "fixture",
		async ainvoke(input) {
			seen.push(structuredClone(input.messages));
			return { messages: [{ role: "assistant", content: "fixture final" }] };
		},
	};
	const a = new Agent({
		llm: model,
		tools: [],
		compaction: null,
		toolOutputCache: null,
	});
	const state = new RuntimeState();
	state.setRuntimeEnvironment({
		environment: { preset: "embedded-no-local-tools" },
		adapters: {
			systemPromptProvider: { loadSystemPrompt: () => "fixture" },
			configProvider: {
				resolveModelConfig: async () => ({
					provider: "openai",
					name: "gpt-6.1-sol",
				}),
			},
			credentialProvider: {
				resolveProvider: async () => "openai",
				resolveProviderAuth: async () => ({
					method: "api_key",
					api_key: "fixture",
				}),
			},
			eventSink: { emit: () => {} },
			toolProviders: [],
		},
	});
	const store = new VolatileSessionStateStore();
	const sent: Array<{
		id?: string;
		result?: { run_id: string; session_id: string };
		error?: unknown;
	}> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		sent.push(JSON.parse(String(chunk)));
		return true;
	});
	let failCreation = false;
	let failStore = false;
	const handlers = createRunHandlers({
		state,
		getAgent: async () => {
			if (failCreation) throw new Error("fixture startup failed");
			state.agent = a;
			return a;
		},
		log: () => {},
		sessionStateStore: store,
		runEventStoreFactory: {
			create: () => {
				if (failStore) throw new Error("fixture event store failed");
				return { append: () => {} };
			},
		},
		appendSession: () => {},
	});
	const run = async (id: string, params: RunStartParams) => {
		await handlers.handleRunStart(id, params);
		for (let n = 0; n < 100 && state.activeRunId; n++) await Bun.sleep(5);
		const result = sent.find((message) => message.id === id)?.result;
		expect(result).toBeDefined();
		expect(state.activeRunId).toBeNull();
		if (!result) throw new Error("Missing run admission");
		return result;
	};
	try {
		const first = await run("one", {
			input: { type: "text", text: "ONLY_FIRST_THREAD" },
			new_session: true,
		});
		const firstSaved = await store.load(first.session_id);
		const previousHistory = structuredClone(a.getHistoryMessages());
		failCreation = true;
		await handlers.handleRunStart("startup-failed", {
			input: { type: "text", text: "NEVER_REPLAY_FAILED" },
			new_session: true,
		});
		expect(
			sent.find((message) => message.id === "startup-failed")?.error,
		).toBeDefined();
		expect(state.sessionId).toBe(first.session_id);
		expect(state.agent).toBe(a);
		expect(a.getHistoryMessages()).toEqual(previousHistory);
		expect(seen).toHaveLength(1);
		expect(state.activeRunId).toBeNull();
		failCreation = false;
		failStore = true;
		await handlers.handleRunStart("event-store-failed", {
			input: { type: "text", text: "NEVER_RUN_STORE_FAILED" },
			new_session: true,
		});
		expect(
			sent.find((message) => message.id === "event-store-failed")?.error,
		).toBeDefined();
		expect(state.sessionId).toBe(first.session_id);
		expect(state.agent).toBe(a);
		expect(a.getHistoryMessages()).toEqual(previousHistory);
		expect(state.activeRunId).toBeNull();
		expect(seen).toHaveLength(1);
		failStore = false;
		const second = await run("two", {
			input: { type: "text", text: "ONLY_SECOND_THREAD" },
			new_session: true,
		});
		expect(second.session_id).not.toBe(first.session_id);
		expect(JSON.stringify(seen[1])).not.toContain("ONLY_FIRST_THREAD");
		expect(await store.load(first.session_id)).toEqual(firstSaved);
		await run("resume", {
			input: { type: "text", text: "FIRST_FOLLOWUP" },
			session_id: first.session_id,
		});
		expect(JSON.stringify(seen[2])).toContain("ONLY_FIRST_THREAD");
		expect(JSON.stringify(seen[2])).not.toContain("ONLY_SECOND_THREAD");
		await handlers.handleRunStart("conflict", {
			input: { type: "text", text: "never" },
			session_id: first.session_id,
			new_session: true,
		});
		expect(
			sent.find((message) => message.id === "conflict")?.error,
		).toBeDefined();
		expect(seen).toHaveLength(3);
	} finally {
		output.mockRestore();
	}
});
