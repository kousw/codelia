import { expect, test } from "bun:test";
import OpenAI from "openai";
import type {
	Response,
	ResponsesClientEvent,
} from "openai/resources/responses/responses";
import { ChatOpenAI } from "../src/llm/openai/chat";
import { Agent } from "../src/agent/agent";
import type { OpenAiResponsesWsLike } from "../src/llm/openai/transport-types";

const baseURL = "https://chatgpt.com/backend-api/codex";
const completed: Response = {
	id: "resp-test",
	model: "requested",
	status: "completed",
	output: [
		{
			type: "message",
			id: "msg",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "done", annotations: [] }],
		},
	],
	usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
} as unknown as Response;
const metadata = {
	type: "response.metadata",
	headers: {
		"x-codex-turn-state": "routing-from-event",
		"openai-model": "gpt-6.1-sol",
	},
	metadata: {
		type: "safety_buffering",
		use_cases: ["cyber"],
		reasons: ["policy-check"],
		openai_verification_recommendation: ["trusted_access_for_cyber"],
		openai_chatgpt_moderation_metadata: { private: "opaque-content" },
	},
};
const encode = (event: unknown) =>
	new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

test("HTTP routing is scoped to run and auth, metadata describes effective model without switching selected model", async () => {
	let token = "owner-a";
	const headers: Headers[] = [];
	const bodies: string[] = [];
	const client = new OpenAI({
		baseURL,
		apiKey: async () => token,
		maxRetries: 0,
		fetch: async (_input, init) => {
			headers.push(new Headers(init?.headers));
			bodies.push(String(init?.body));
			return new globalThis.Response(
				[
					{ type: "response.created", response: { ...completed, output: [] } },
					metadata,
					{
						type: "response.completed",
						response: {
							...completed,
							headers: { "x-codex-turn-state": "must-not-persist" },
						},
					},
				]
					.map((event) => new TextDecoder().decode(encode(event)))
					.join(""),
				{
					headers: {
						"content-type": "text/event-stream",
						"x-codex-turn-state": "routing-from-header",
					},
				},
			);
		},
	});
	const chat = new ChatOpenAI({ client, model: "requested" });
	const input = { messages: [{ role: "user" as const, content: "hi" }] };
	const a = { sessionKey: "session", turnKey: "turn-a" };
	const result = await chat.ainvoke(input, a);
	await chat.ainvoke(input, a);
	await chat.ainvoke(input, { ...a, turnKey: "turn-b" });
	await chat.ainvoke(input, { ...a, turnKey: "turn-b" });
	token = "owner-b";
	await expect(
		chat.ainvoke(input, { ...a, turnKey: "turn-b" }),
	).rejects.toThrow("OpenAI authentication changed");
	await chat.ainvoke(input, { ...a, turnKey: "turn-c" });
	expect(headers.map((header) => header.get("x-codex-turn-state"))).toEqual([
		null,
		"routing-from-header",
		null,
		"routing-from-header",
		null,
	]);
	expect(chat.model).toBe("requested");
	expect(result.usage).toMatchObject({
		model: "requested",
		provider_model: "gpt-6.1-sol",
	});
	expect(result.provider_meta).toMatchObject({
		codex_metadata: { moderation_metadata_present: true },
	});
	for (const body of bodies) expect(body).not.toContain("routing");
	const serialized = JSON.stringify(result);
	expect(serialized).not.toContain("opaque-content");
	expect(serialized).not.toContain("routing-from");
	expect(serialized).not.toContain("must-not-persist");
});

test("Agent delivers verification/buffering before HTTP completion and keeps status out of assistant history", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const client = new OpenAI({
		baseURL,
		apiKey: "owner-a",
		maxRetries: 0,
		fetch: async () =>
			new globalThis.Response(
				new ReadableStream({
					start(value) {
						controller = value;
						controller.enqueue(
							encode({
								type: "response.created",
								response: { ...completed, output: [] },
							}),
						);
						controller.enqueue(encode(metadata));
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	const agent = new Agent({
		llm: new ChatOpenAI({ client, model: "requested" }),
		tools: [],
	});
	const stream = agent.runStream("hi");
	const first = await stream.next();
	expect(first.done).toBe(false);
	expect(first.value).toMatchObject({
		type: "llm.status",
		kind: "verification",
	});
	const second = await stream.next();
	expect(second.value).toMatchObject({
		type: "llm.status",
		kind: "buffering",
		active: true,
	});
	controller.enqueue(
		encode({ type: "response.completed", response: completed }),
	);
	controller.close();
	const events = [];
	for await (const event of stream) events.push(event);
	expect(events).toContainEqual({
		type: "llm.status",
		provider: "openai",
		kind: "buffering",
		active: false,
	});
	expect(JSON.stringify(agent.getHistoryMessages())).not.toContain("buffering");
	expect(JSON.stringify(agent.getHistoryMessages())).toContain("done");
});

class Socket implements OpenAiResponsesWsLike {
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
	readonly sent: unknown[] = [];
	closed = 0;
	on(name: string, fn: (event: unknown) => void) {
		const set = this.listeners.get(name) ?? new Set();
		set.add(fn);
		this.listeners.set(name, set);
		return this;
	}
	off(name: string, fn: (event: unknown) => void) {
		this.listeners.get(name)?.delete(fn);
		return this;
	}
	send(event: ResponsesClientEvent) {
		this.sent.push(event);
		queueMicrotask(() => {
			this.emit(metadata);
			this.emit({ type: "response.completed", response: completed });
		});
	}
	close() {
		this.closed++;
	}
	private emit(event: unknown) {
		for (const fn of this.listeners.get("event") ?? []) fn(event);
	}
}

test("WS metadata is handled, routing is replayed in client_metadata, and a new turn opens a fresh connection", async () => {
	const sockets: Socket[] = [];
	const client = new OpenAI({ baseURL, apiKey: "owner-a", maxRetries: 0 });
	const chat = new ChatOpenAI({
		client,
		model: "requested",
		websocketMode: "on",
		createResponsesWs: () => {
			const ws = new Socket();
			sockets.push(ws);
			return ws;
		},
	});
	const a = { sessionKey: "session", turnKey: "turn-a" };
	const first = await chat.ainvoke(
		{ messages: [{ role: "user", content: "hi" }] },
		a,
	);
	await chat.ainvoke(
		{
			messages: [
				{ role: "user", content: "hi" },
				...first.messages,
				{ role: "user", content: "continue" },
			],
		},
		a,
	);
	expect(sockets).toHaveLength(1);
	expect(sockets[0].sent[1]).toMatchObject({
		client_metadata: { "x-codex-turn-state": "routing-from-event" },
	});
	const second = await chat.ainvoke(
		{ messages: [{ role: "user", content: "next" }] },
		{ ...a, turnKey: "turn-b" },
	);
	expect(sockets).toHaveLength(2);
	expect(sockets[0].closed).toBeGreaterThan(0);
	expect(sockets[1].sent[0]).not.toHaveProperty("client_metadata");
	expect(second.provider_meta).toMatchObject({
		codex_metadata: {
			server_model: "gpt-6.1-sol",
			model_verifications: ["trusted_access_for_cyber"],
		},
	});
	chat.onHistoryCompacted();
});

test("WS ownership change is terminal in auto mode and cannot fall back to HTTP", async () => {
	let token = "owner-a";
	let httpRequests = 0;
	const client = new OpenAI({
		baseURL,
		apiKey: async () => token,
		maxRetries: 0,
		fetch: async () => {
			httpRequests++;
			throw new Error("HTTP must not run");
		},
	});
	const sockets: Socket[] = [];
	const chat = new ChatOpenAI({
		client,
		model: "requested",
		websocketMode: "auto",
		createResponsesWs: () => {
			const socket = new Socket();
			sockets.push(socket);
			return socket;
		},
	});
	const context = { sessionKey: "session", turnKey: "turn" };
	const first = await chat.ainvoke(
		{ messages: [{ role: "user", content: "hi" }] },
		context,
	);
	token = "owner-b";
	await expect(
		chat.ainvoke(
			{
				messages: [
					{ role: "user", content: "hi" },
					...first.messages,
					{ role: "user", content: "continue" },
				],
			},
			context,
		),
	).rejects.toThrow("OpenAI authentication changed");
	expect(httpRequests).toBe(0);
	expect(sockets[0].sent).toHaveLength(1);
});

test("evicting a turn scope closes its sticky WS connection before that session is reused", async () => {
	const sockets: Socket[] = [];
	const client = new OpenAI({ baseURL, apiKey: "owner-a", maxRetries: 0 });
	const chat = new ChatOpenAI({
		client,
		model: "requested",
		websocketMode: "on",
		createResponsesWs: () => {
			const socket = new Socket();
			sockets.push(socket);
			return socket;
		},
	});
	for (let i = 0; i < 17; i++)
		await chat.ainvoke(
			{ messages: [{ role: "user", content: "hi" }] },
			{ sessionKey: `session-${i}`, turnKey: `turn-${i}` },
		);
	expect(sockets[0].closed).toBeGreaterThan(0);
	await chat.ainvoke(
		{ messages: [{ role: "user", content: "hi" }] },
		{ sessionKey: "session-0", turnKey: "turn-0" },
	);
	expect(sockets).toHaveLength(18);
	expect(sockets[17].sent[0]).not.toHaveProperty("client_metadata");
	chat.onHistoryCompacted();
});
