import { expect, test } from "bun:test";
import { GoogleGenAI } from "@google/genai";
import type { ChatStreamDelta } from "../src/llm/base";
import { ChatGoogle } from "../src/llm/google/chat";
import {
	fromGoogleInteraction,
	toGoogleInput,
} from "../src/llm/google/serializer";
import { collectGoogleStream } from "../src/llm/google/stream";

const reply = {
	id: "interaction-1",
	model: "gemini-4-hydrogen",
	status: "requires_action",
	steps: [
		{ type: "thought", summary: [], signature: "opaque-signature" },
		{
			type: "function_call",
			id: "call-1",
			name: "read_file",
			arguments: { path: "a.txt" },
		},
	],
	usage: {
		total_input_tokens: 10,
		total_output_tokens: 3,
		total_thought_tokens: 2,
		total_cached_tokens: 4,
		total_tokens: 15,
	},
};

test("Google streaming EOF without terminal event fails closed", async () => {
	const stream = (async function* () {
		yield {
			event_type: "step.start",
			index: 0,
			step: {
				type: "model_output",
				content: [{ type: "text", text: "partial" }],
			},
		};
		yield { event_type: "step.stop", index: 0 };
	})();
	await expect(collectGoogleStream(stream, "gemini-4-hydrogen")).rejects.toThrow(
		"before completion",
	);
});

test("stateless Google turn preserves signed thought, call identity and tool result on replay", async () => {
	const captured: unknown[] = [];
	const client = {
		interactions: {
			create: async (request: unknown) => {
				captured.push(request);
				return (async function* () {
					if (captured.length === 1) {
						yield {
							event_type: "step.start",
							index: 0,
							step: { type: "thought", summary: [], signature: "" },
						};
						yield {
							event_type: "step.delta",
							index: 0,
							delta: {
								type: "thought_signature",
								signature: "opaque-signature",
							},
						};
						yield { event_type: "step.stop", index: 0 };
						yield {
							event_type: "step.start",
							index: 1,
							step: {
								type: "function_call",
								id: "call-1",
								name: "read_file",
								arguments: {},
							},
						};
						yield {
							event_type: "step.delta",
							index: 1,
							delta: { type: "arguments_delta", arguments: '{"path":"a.txt"}' },
						};
						yield { event_type: "step.stop", index: 1 };
						yield {
							event_type: "interaction.completed",
							interaction: {
								status: "requires_action",
								model: "gemini-4-hydrogen",
								usage: reply.usage,
							},
						};
					} else {
						yield {
							event_type: "step.start",
							index: 0,
							step: {
								type: "model_output",
								content: [{ type: "text", text: "do" }],
							},
						};
						yield {
							event_type: "step.delta",
							index: 0,
							delta: { type: "text", text: "ne" },
						};
						yield { event_type: "step.stop", index: 0 };
						yield {
							event_type: "interaction.completed",
							interaction: { status: "completed", model: "gemini-4-hydrogen" },
						};
					}
				})();
			},
		},
	} as unknown as GoogleGenAI;
	const google = new ChatGoogle({ apiKey: "fixture", client });
	const first = await google.ainvoke({
		messages: [{ role: "user", content: "Read a.txt" }],
		tools: [
			{
				name: "read_file",
				description: "Read file",
				parameters: { type: "object" },
			},
		],
	});
	expect(first.usage?.output_tokens).toBe(5);
	expect(first.usage?.output_reasoning_tokens).toBe(2);
	expect(first.messages[0]).toMatchObject({
		role: "reasoning",
		raw_item: reply.steps[0],
	});
	const second = await google.ainvoke({
		messages: [
			{ role: "user", content: "Read a.txt" },
			...first.messages,
			{
				role: "tool",
				tool_call_id: "call-1",
				tool_name: "read_file",
				content: "contents",
			},
		],
	});
	expect(second.messages).toMatchObject([
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	]);
	expect(captured[0]).toMatchObject({
		store: false,
		model: "gemini-4-hydrogen",
	});
	expect(captured[1]).toMatchObject({
		store: false,
		input: [
			{ type: "user_input" },
			{ type: "thought", signature: "opaque-signature", summary: [] },
			{ type: "function_call", id: "call-1", name: "read_file" },
			{
				type: "function_result",
				call_id: "call-1",
				name: "read_file",
				result: "contents",
			},
		],
	});
});

test("failed and truncated Google interactions never become successful turns", () => {
	for (const status of ["failed", "incomplete", "cancelled", "in_progress"])
		expect(() =>
			fromGoogleInteraction({ ...reply, status }, "gemini-4-hydrogen"),
		).toThrow("did not complete");
	expect(() =>
		fromGoogleInteraction({ status: "completed" }, "gemini-4-hydrogen"),
	).toThrow("incomplete");
	expect(() =>
		fromGoogleInteraction(
			{ status: "completed", steps: [{ type: "thought", summary: [] }] },
			"gemini-4-hydrogen",
		),
	).toThrow("no model output");
});

test("image input is inline and invalid remote URLs stop before an API request", () => {
	expect(
		toGoogleInput([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: {
							url: "data:image/png;base64,YQ==",
							media_type: "image/png",
						},
					},
				],
			},
		]).steps,
	).toEqual([
		{
			type: "user_input",
			content: [{ type: "image", mime_type: "image/png", data: "YQ==" }],
		},
	]);
	expect(() =>
		toGoogleInput([
			{
				role: "user",
				content: [
					{
						type: "image_url",
						image_url: { url: "https://example.com/a.png" },
					},
				],
			},
		]),
	).toThrow("inline data URL");
});

test.each([
	["gemini-4-carbon", "medium"],
	["gemini-4-hydrogen", "xhigh"],
	["gemini-4-hydrogen", undefined],
] as const)(
	"official SDK sends %s/%s statelessly with signed replay",
	async (model, thinkingLevel) => {
		let body: Record<string, unknown> | undefined;
		let calls = 0;
		const sdk = new GoogleGenAI({
			apiKey: "fixture",
			httpOptions: {
				fetch: async (input, init) => {
					calls++;
					body = JSON.parse(await new Request(input, init).text());
					const events = [
						{
							event_type: "step.start",
							index: 0,
							step: { type: "thought", signature: "" },
						},
						{
							event_type: "step.delta",
							index: 0,
							delta: { type: "thought_signature", signature: "signed" },
						},
						{ event_type: "step.stop", index: 0 },
						{
							event_type: "step.start",
							index: 1,
							step: {
								type: "model_output",
								content: [{ type: "text", text: "Hi" }],
							},
						},
						{ event_type: "step.stop", index: 1 },
						{
							event_type: "interaction.completed",
							interaction: {
								id: "int-1",
								status: "completed",
								model,
								usage: {
									total_input_tokens: 5,
									total_output_tokens: 1,
									total_thought_tokens: 2,
									total_tokens: 8,
								},
							},
						},
					];
					const sse = events
						.map(
							(event) =>
								`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join("");
					return new Response(`${sse}data: [DONE]\n\n`, {
						headers: { "content-type": "text/event-stream" },
					});
				},
			},
		});
		const completion = await new ChatGoogle({
			apiKey: "fixture",
			client: sdk,
			model,
			thinkingLevel,
		}).ainvoke({ messages: [{ role: "user", content: "Hello" }] });
		expect(calls).toBe(1);
		expect(body).toMatchObject({
			store: false,
			stream: true,
			model,
			generation_config: {
				max_output_tokens: 65_536,
				...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
			},
		});
		const generationConfig = body?.generation_config as Record<string, unknown>;
		if (!thinkingLevel)
			expect(generationConfig).not.toHaveProperty("thinking_level");
		expect(completion.messages).toMatchObject([
			{ role: "reasoning", raw_item: { signature: "signed" } },
			{ role: "assistant", content: [{ text: "Hi" }] },
		]);
	},
);

test("Google stream forwards thought summary and model output deltas per step", async () => {
	const stream = (async function* () {
		yield {
			event_type: "step.start",
			index: 0,
			step: { type: "thought", summary: [], signature: "" },
		};
		for (const text of ["Thin", "king"])
			yield {
				event_type: "step.delta",
				index: 0,
				delta: { type: "thought_summary", content: { type: "text", text } },
			};
		yield { event_type: "step.stop", index: 0 };
		yield {
			event_type: "step.start",
			index: 1,
			step: { type: "model_output", content: [] },
		};
		for (const text of ["Hel", "lo"])
			yield {
				event_type: "step.delta",
				index: 1,
				delta: { type: "text", text },
			};
		yield { event_type: "step.stop", index: 1 };
		yield {
			event_type: "interaction.completed",
			interaction: {
				id: "int-1",
				status: "completed",
				model: "gemini-4-hydrogen",
				usage: {
					total_input_tokens: 1,
					total_output_tokens: 1,
					total_tokens: 2,
				},
			},
		};
	})();
	const deltas: ChatStreamDelta[] = [];

	const completion = await collectGoogleStream(
		stream,
		"gemini-4-hydrogen",
		(delta) => deltas.push(delta),
	);

	expect(deltas).toEqual([
		{ kind: "reasoning", index: 0, delta: "Thin" },
		{ kind: "reasoning", index: 0, delta: "king" },
		{ kind: "text", index: 0, delta: "Hel" },
		{ kind: "text", index: 0, delta: "lo" },
	]);
	expect(completion.messages).toContainEqual(
		expect.objectContaining({ role: "reasoning", content: "Thinking" }),
	);
	expect(completion.timing).toBeDefined();
});
