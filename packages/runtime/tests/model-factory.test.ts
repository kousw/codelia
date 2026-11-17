import { describe, expect, test } from "bun:test";
import type { SupportedProvider } from "../src/auth/resolver";
import type { ProviderAuth } from "../src/auth/store";
import { createRuntimeModel } from "../src/model-factory";

const apiKeyAuth: ProviderAuth = {
	method: "api_key",
	api_key: "test-api-key",
};

const cases: Array<{
	provider: SupportedProvider;
	model: string;
}> = [
	{ provider: "openai", model: "gpt-5.6" },
	{ provider: "openrouter", model: "openai/gpt-5.6" },
	{ provider: "anthropic", model: "claude-sonnet-4-6" },
	{ provider: "zai", model: "glm-5.2" },
	{ provider: "moonshot", model: "kimi-k3" },
	{ provider: "xai", model: "grok-4.5" },
	{ provider: "google", model: "gemini-3.8-flash" },
	{ provider: "google", model: "gemini-4-carbon" },
	{ provider: "google", model: "gemini-4-hydrogen" },
	{ provider: "deepseek", model: "deepseek-flash" },
	{ provider: "deepseek", model: "deepseek-v4-pro" },
];

describe("runtime model factory", () => {
	test.each([
		["gemini-4-hydrogen", "xhigh", undefined],
		["gemini-4-hydrogen", "max", "xhigh"],
		["gemini-4-carbon", "xhigh", "high"],
	] as const)(
		"reports only actual Google reasoning fallback for %s/%s",
		async (name, reasoning, fallback) => {
			const logs: string[] = [];
			await createRuntimeModel({
				provider: "google",
				config: { name, reasoning },
				auth: apiKeyAuth,
				useMetadata: false,
				log: (message) => logs.push(message),
			});
			expect(logs).toEqual(
				fallback
					? [`Google ${reasoning} reasoning maps to ${fallback} for ${name}`]
					: [],
			);
		},
	);

	test("DeepSeek resolves its default alias and refuses OAuth", async () => {
		const input = {
			provider: "deepseek",
			config: { name: "default" },
			auth: apiKeyAuth,
			useMetadata: false,
			log: () => {},
		};
		const result = await createRuntimeModel(input);
		expect(result.resolvedModelName).toBe("deepseek-flash");
		expect(result.llm.model).toBe("deepseek-flash");
		await expect(
			createRuntimeModel({
				...input,
				auth: {
					method: "oauth",
					oauth: {
						access_token: "fixture",
						refresh_token: "fixture",
						expires_at: 0,
					},
				},
			}),
		).rejects.toThrow("DeepSeek requires an API key");
	});
	test.each([undefined, "default"])(
		"resolves Google model %s to its concrete default ID",
		async (name) => {
			const result = await createRuntimeModel({
				provider: "google",
				config: { ...(name ? { name } : {}) },
				auth: apiKeyAuth,
				useMetadata: false,
				log: () => {},
			});

			expect(result.llm.model).toBe("gemini-3.8-flash");
			expect(result.resolvedModelName).toBe("gemini-3.8-flash");
		},
	);

	test("rejects unknown Google model names without falling back", async () => {
		await expect(
			createRuntimeModel({
				provider: "google",
				config: { name: "unknown-google-model" },
				auth: apiKeyAuth,
				useMetadata: false,
				log: () => {},
			}),
		).rejects.toThrow("Unsupported Google model: unknown-google-model");
	});

	for (const { provider, model } of cases) {
		test(`constructs the ${provider} adapter from explicit inputs`, async () => {
			const result = await createRuntimeModel({
				provider,
				config: {
					name: model,
					reasoning: "medium",
					fast: true,
				},
				auth: apiKeyAuth,
				useMetadata: false,
				log: () => {},
			});

			expect(result.llm.provider).toBe(provider);
			expect(result.llm.model).toBe(model);
			expect(result.resolvedModelName).toBe(model);
		});
	}

	test("rejects OAuth credentials for API-key-only providers", async () => {
		await expect(
			createRuntimeModel({
				provider: "anthropic",
				config: { name: "claude-sonnet-4-6" },
				auth: {
					method: "oauth",
					oauth: {
						access_token: "test-access-token",
						refresh_token: "test-refresh-token",
						expires_at: Date.now() + 60_000,
					},
				},
				useMetadata: false,
				log: () => {},
			}),
		).rejects.toThrow("Anthropic requires an API key");
	});
});

test.each([
	[
		"openai",
		"gpt-6.2-astra",
		"max",
		"ultrafast",
		{ service_tier: "ultrafast", reasoning: { effort: "max" } },
	],
	[
		"openai",
		"gpt-6.2-sol",
		"xhigh",
		true,
		{ service_tier: "priority", reasoning: { effort: "xhigh" } },
	],
	[
		"openai",
		"gpt-6-astra",
		"max",
		"ultrafast",
		{ service_tier: "ultrafast", reasoning: { effort: "max" } },
	],
	[
		"openai",
		"gpt-6.1-sol",
		"high",
		"ultrafast",
		{ service_tier: "ultrafast", reasoning: { effort: "high" } },
	],
	[
		"anthropic",
		"claude-fable-5-2",
		"max",
		true,
		{
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "max" },
			max_tokens: 128_000,
			speed: "fast",
		},
	],
	[
		"anthropic",
		"claude-sonnet-5-5",
		"xhigh",
		false,
		{
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "xhigh" },
			max_tokens: 128_000,
		},
	],
	[
		"anthropic",
		"claude-haiku-5-5",
		"max",
		false,
		{
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "max" },
			max_tokens: 128_000,
		},
	],
	["xai", "grok-4.7", "xhigh", false, { reasoning: { effort: "xhigh" } }],
	["moonshot", "kimi-k3.1-pro", "low", false, { reasoning_effort: "low" }],
	[
		"moonshot",
		"kimi-k3.1-pro-highspeed",
		"high",
		false,
		{ reasoning_effort: "high" },
	],
	[
		"zai",
		"glm-5.3",
		"low",
		false,
		{ reasoning_effort: "low", thinking: { type: "enabled" } },
	],
	[
		"google",
		"gemini-4-carbon",
		"medium",
		false,
		{ generation_config: { thinking_level: "medium" } },
	],
	[
		"google",
		"gemini-4-hydrogen",
		"xhigh",
		false,
		{ generation_config: { thinking_level: "xhigh" } },
	],
	[
		"google",
		"gemini-4-hydrogen",
		"max",
		false,
		{ generation_config: { thinking_level: "xhigh" } },
	],
	[
		"google",
		"gemini-4-hydrogen",
		undefined,
		false,
		{ generation_config: { max_output_tokens: 65_536 } },
	],
] as const)(
	"sends the selected %s/%s contract through the runtime factory",
	async (provider, model, reasoning, fast, expected) => {
		const previousFetch = globalThis.fetch;
		const bodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = Object.assign(
			async (input: URL | RequestInfo, init?: RequestInit) => {
				bodies.push(JSON.parse(await new Request(input, init).text()));
				if (provider === "google") {
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
							interaction: { status: "completed", model },
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
				}
				if (provider === "anthropic") {
					const events = [
						{
							type: "message_start",
							message: {
								id: "msg_test",
								type: "message",
								role: "assistant",
								model,
								content: [],
								stop_reason: null,
								stop_sequence: null,
								usage: { input_tokens: 1, output_tokens: 0 },
							},
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: "done" },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn", stop_sequence: null },
							usage: { output_tokens: 1 },
						},
						{ type: "message_stop" },
					];
					return new Response(
						events
							.map(
								(event) =>
									`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
							)
							.join(""),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}

				const terminal =
					provider === "openai" || provider === "xai"
						? {
								type: "response.completed",
								sequence_number: 1,
								response: {
									id: "resp_test",
									object: "response",
									created_at: 1,
									model,
									status: "completed",
									output: [
										{
											id: "msg_test",
											type: "message",
											status: "completed",
											role: "assistant",
											content: [
												{ type: "output_text", text: "done", annotations: [] },
											],
										},
									],
									usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
								},
							}
						: {
								id: "cmpl_test",
								model,
								choices: [
									{ delta: { content: "done" }, finish_reason: "stop" },
								],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									total_tokens: 2,
								},
							};
				const events =
					"response" in terminal
						? [
								{
									type: "response.created",
									sequence_number: 0,
									response: {
										...terminal.response,
										status: "in_progress",
										output: [],
									},
								},
								terminal,
							]
						: [terminal];
				return new Response(
					events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
			{ preconnect: previousFetch.preconnect },
		) as typeof fetch;
		try {
			const { llm } = await createRuntimeModel({
				provider,
				config: {
					name: model,
					reasoning,
					fast,
					experimental: { openai: { websocket_mode: "off" } },
				},
				auth: apiKeyAuth,
				useMetadata: false,
				log: () => {},
			});
			const completion = await llm.ainvoke({
				messages: [{ role: "user", content: "work" }],
			});
			expect(bodies).toHaveLength(1);
			expect(bodies[0]).toMatchObject({ model, ...expected });
			if (provider === "google") {
				expect(bodies[0]).toMatchObject({
					store: false,
					stream: true,
					generation_config: { max_output_tokens: 65_536 },
				});
				if (!reasoning)
					expect(bodies[0]?.generation_config).not.toHaveProperty(
						"thinking_level",
					);
			}
			expect(completion.messages.at(-1)).toMatchObject({ role: "assistant" });
			if (provider === "moonshot")
				expect(completion.provider_meta).toMatchObject({
					reasoning_applied: reasoning,
					reasoning_effort: reasoning,
					reasoning_fallback: false,
				});
		} finally {
			globalThis.fetch = previousFetch;
		}
	},
);

test("rejects Ultrafast with Codex OAuth without refreshing or changing auth", async () => {
	let refreshes = 0;
	await expect(
		createRuntimeModel({
			provider: "openai",
			config: { name: "gpt-6-astra", fast: "ultrafast" },
			auth: {
				method: "oauth",
				oauth: { access_token: "test", refresh_token: "test", expires_at: 0 },
			},
			useMetadata: false,
			log: () => {},
			getOpenAiAccessToken: async () => {
				refreshes++;
				return { token: "test" };
			},
		}),
	).rejects.toThrow("requires OpenAI API-key authentication");
	expect(refreshes).toBe(0);
});
