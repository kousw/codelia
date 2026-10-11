import { expect, spyOn, test } from "bun:test";
import { Agent, type BaseChatModel } from "@codelia/core";
import { resolveEffectiveModelConfig } from "../src/effective-model";
import { createModelHandlers } from "../src/rpc/model";
import { createRunHandlers } from "../src/rpc/run";
import { RuntimeState } from "../src/runtime-state";
import { VolatileSessionStateStore } from "../src/volatile-stores";

const fixtureState = (onRead: () => void) => {
	const state = new RuntimeState();
	state.setRuntimeEnvironment({
		environment: { preset: "embedded-no-local-tools" },
		adapters: {
			systemPromptProvider: { loadSystemPrompt: () => "fixture" },
			configProvider: {
				resolveModelConfig: async () => {
					onRead();
					return { provider: "home", name: "fixture-invalid" };
				},
			},
			credentialProvider: {
				resolveProvider: async () => {
					throw new Error("No auth allowed in catalog fixture");
				},
				resolveProviderAuth: async () => {
					throw new Error("No auth allowed in catalog fixture");
				},
			},
			eventSink: { emit: () => {} },
			toolProviders: [],
		},
	});
	return state;
};
const capture = () => {
	const messages: Array<{
		id?: string;
		result?: Record<string, unknown>;
		error?: unknown;
	}> = [];
	const output = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		messages.push(JSON.parse(String(chunk)));
		return true;
	});
	return { messages, close: () => output.mockRestore() };
};

test("unsupported configured provider still permits explicit offline catalogs without config or auth changes", async () => {
	let reads = 0;
	const state = fixtureState(() => {
		reads++;
	});
	const output = capture();
	try {
		const handlers = createModelHandlers({ state, log: () => {} });
		await handlers.handleModelList("configured", {});
		expect(
			output.messages.find((m) => m.id === "configured")?.error,
		).toBeDefined();
		const previousReads = reads;
		await handlers.handleModelList("openai", {
			provider: "openai",
			catalog_only: true,
		});
		const result = output.messages.find((m) => m.id === "openai")?.result;
		expect(result?.catalog_only).toBe(true);
		expect(result?.models).toContain("gpt-6.1-sol");
		await handlers.handleModelList("bad", {
			provider: "home",
			catalog_only: true,
		});
		expect(output.messages.find((m) => m.id === "bad")?.error).toBeDefined();
		expect(reads).toBe(previousReads);
		expect(state.sessionModelOverride).toBeNull();
		expect(state.activeRunId).toBeNull();
	} finally {
		output.close();
	}
});

test("explicit run model repairs a fresh thread without changing old session or config, and failed admission rolls back", async () => {
	const state = fixtureState(() => {});
	const store = new VolatileSessionStateStore();
	const oldOverride = { provider: "anthropic", name: "claude-opus-5" };
	state.sessionId = "prior-session";
	state.sessionModelOverride = oldOverride;
	await store.save({
		schema_version: 1,
		session_id: "prior-session",
		updated_at: "fixture",
		messages: [{ role: "user", content: "prior only" }],
		meta: { codelia_model_override: oldOverride },
	});
	const oldRecord = await store.load("prior-session");
	const observed: Array<{ provider?: string; name?: string }> = [];
	let failCreation = true;
	const output = capture();
	try {
		const handlers = createRunHandlers({
			state,
			log: () => {},
			sessionStateStore: store,
			runEventStoreFactory: { create: () => ({ append: () => {} }) },
			appendSession: () => {},
			getAgent: async () => {
				if (failCreation) throw new Error("Fixture admission rejected");
				const config = await resolveEffectiveModelConfig(state);
				observed.push({ provider: config.provider, name: config.name });
				if (config.provider === "home")
					throw new Error("Unrecovered fixture provider");
				const llm: BaseChatModel = {
					provider: "openai",
					model: "fixture",
					async ainvoke() {
						return {
							messages: [{ role: "assistant", content: "fixture final" }],
						};
					},
				};
				const agent = new Agent({
					llm,
					tools: [],
					compaction: null,
					toolOutputCache: null,
				});
				state.agent = agent;
				return agent;
			},
		});
		const params = {
			input: { type: "text" as const, text: "new thread" },
			new_session: true,
			model: { provider: "openai", name: "gpt-6.1-sol" },
		};
		await handlers.handleRunStart("fail", params);
		expect(output.messages.find((m) => m.id === "fail")?.error).toBeDefined();
		expect(state.sessionId).toBe("prior-session");
		expect(state.sessionModelOverride).toEqual(oldOverride);
		expect(await store.load("prior-session")).toEqual(oldRecord);
		await handlers.handleRunStart("invalid", {
			...params,
			model: { provider: "home", name: "bad" },
		});
		expect(
			output.messages.find((m) => m.id === "invalid")?.error,
		).toBeDefined();
		expect(observed).toHaveLength(0);
		failCreation = false;
		await handlers.handleRunStart("new", params);
		for (let n = 0; n < 100 && state.activeRunId; n++) await Bun.sleep(5);
		const next = output.messages.find((m) => m.id === "new")?.result;
		expect(next?.session_id).not.toBe("prior-session");
		expect(observed[0]).toEqual(params.model);
		expect(
			(await store.load(String(next?.session_id)))?.meta
				?.codelia_model_override,
		).toEqual(params.model);
		expect(await store.load("prior-session")).toEqual(oldRecord);
		await handlers.handleRunStart("resume", {
			input: { type: "text", text: "prior followup" },
			session_id: "prior-session",
		});
		for (let n = 0; n < 100 && state.activeRunId; n++) await Bun.sleep(5);
		expect(observed[1]).toEqual(oldOverride);
		expect(state.activeRunId).toBeNull();
		expect(
			(await resolveEffectiveModelConfig(fixtureState(() => {}))).provider,
		).toBe("home");
	} finally {
		output.close();
	}
});
