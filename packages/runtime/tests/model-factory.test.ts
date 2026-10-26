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
];

describe("runtime model factory", () => {
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
] as const)(
	"sends the selected %s/%s contract through the runtime factory",
	async (provider, model, reasoning, fast, expected) => {
		const previousFetch = globalThis.fetch;
		const bodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = Object.assign(
			async (_input: URL | RequestInfo, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
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
