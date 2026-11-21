import { expect, test } from "bun:test";
import { type BaseMessage, ChatGoogle } from "@codelia/core";
import { GoogleGenAI } from "@google/genai";
import { normalizeToolCallHistory } from "../src/rpc/run-debug";

test("Google replay keeps completed calls and drops calls removed after cancellation", async () => {
	const thought = { type: "thought", summary: [], signature: "signed-thought" };
	const calls = ["completed", "cancelled"].map((id) => ({
		type: "function_call",
		id,
		name: "read_file",
		arguments: { path: `${id}.txt` },
		signature: `signed-${id}`,
	}));
	const history: BaseMessage[] = [
		{ role: "user", content: "Read both files" },
		{ role: "reasoning", content: "", raw_item: thought },
		...calls.map(
			(call): BaseMessage => ({
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: call.id,
						type: "function",
						function: {
							name: call.name,
							arguments: JSON.stringify(call.arguments),
						},
					},
				],
				provider_meta: call,
			}),
		),
		{
			role: "tool",
			tool_call_id: "completed",
			tool_name: "read_file",
			content: "contents",
		},
	];
	const normalized = normalizeToolCallHistory(history);
	let requestBody: Record<string, unknown> | undefined;
	const client = new GoogleGenAI({
		apiKey: "fixture",
		httpOptions: {
			fetch: async (input, init) => {
				requestBody = JSON.parse(await new Request(input, init).text());
				const events = [
					{
						event_type: "step.start",
						index: 0,
						step: {
							type: "model_output",
							content: [{ type: "text", text: "done" }],
						},
					},
					{ event_type: "step.stop", index: 0 },
					{
						event_type: "interaction.completed",
						interaction: { status: "completed", model: "gemini-4-hydrogen" },
					},
				];
				return new Response(
					events
						.map(
							(event) =>
								`event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`,
						)
						.join(""),
					{
						headers: { "content-type": "text/event-stream" },
					},
				);
			},
		},
	});
	await new ChatGoogle({ apiKey: "fixture", client }).ainvoke({
		messages: [...normalized, { role: "user", content: "Continue" }],
	});

	expect(requestBody?.store).toBe(false);
	expect(requestBody?.input).toEqual([
		{
			type: "user_input",
			content: [{ type: "text", text: "Read both files" }],
		},
		thought,
		calls[0],
		{
			type: "function_result",
			call_id: "completed",
			name: "read_file",
			result: "contents",
		},
		{ type: "user_input", content: [{ type: "text", text: "Continue" }] },
	]);
	expect(history[3]).toMatchObject({
		tool_calls: [{ id: "cancelled" }],
		provider_meta: calls[1],
	});
});
