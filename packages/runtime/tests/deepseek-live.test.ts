import { expect, test } from "bun:test";
import type { BaseMessage, ToolDefinition } from "@codelia/core";
import { createRuntimeModel } from "../src/model-factory";

const apiKey = process.env.DEEPSEEK_API_KEY;
const live =
	process.env.INTEGRATION === "1" &&
	process.env.CODELIA_TEST_DEEPSEEK_LIVE === "1" &&
	!!apiKey;

for (const model of ["deepseek-flash", "deepseek-v4-pro"]) {
	(live ? test : test.skip)(
		`live DeepSeek ${model} stateless tool roundtrip (chargeable)`,
		async () => {
			const { llm } = await createRuntimeModel({
				provider: "deepseek",
				config: { name: model, reasoning: "low" },
				auth: { method: "api_key", api_key: apiKey ?? "" },
				useMetadata: false,
				log: () => {},
			});
			const messages: BaseMessage[] = [
				{
					role: "user",
					content:
						'Call smoke_echo once with value="verified". After the tool result, reply with only OK.',
				},
			];
			const tools: ToolDefinition[] = [
				{
					name: "smoke_echo",
					description: "Echoes a supplied test value without side effects.",
					parameters: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
						additionalProperties: false,
					},
				},
			];
			const first = await llm.ainvoke({
				messages,
				tools,
				options: { maxOutputTokens: 1024 },
				signal: AbortSignal.timeout(90_000),
			});
			const calls = first.messages.flatMap((m) =>
				m.role === "assistant" ? (m.tool_calls ?? []) : [],
			);
			expect(calls).toHaveLength(1);
			expect(calls[0].function.name).toBe("smoke_echo");
			expect(JSON.parse(calls[0].function.arguments)).toEqual({
				value: "verified",
			});
			const final = await llm.ainvoke({
				messages: [
					...messages,
					...first.messages,
					{
						role: "tool",
						tool_call_id: calls[0].id,
						tool_name: "smoke_echo",
						content: "verified",
					},
				],
				tools,
				toolChoice: "none",
				options: { maxOutputTokens: 1024 },
				signal: AbortSignal.timeout(90_000),
			});
			const answer = final.messages
				.filter((m) => m.role === "assistant")
				.map((m) =>
					typeof m.content === "string"
						? m.content
						: (m.content ?? [])
								.filter((p) => p.type === "text")
								.map((p) => p.text)
								.join(""),
				)
				.join("")
				.trim();
			expect(answer).toMatch(/^OK[.!]?$/);
			expect(final.usage?.model).toBe(model);
		},
		185_000,
	);
}
