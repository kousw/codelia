import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatZai } from "../src/llm/zai/chat";

type FetchCall = {
	input: Parameters<typeof fetch>[0];
	init?: Parameters<typeof fetch>[1];
};

const sse = (items: unknown[]): string =>
	`${items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;

const buildMockFetch = (
	handler: (
		input: Parameters<typeof fetch>[0],
		init?: Parameters<typeof fetch>[1],
	) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

describe("ChatZai", () => {
	const envSnapshot = new Map<string, string | undefined>();
	const setEnv = (key: string, value: string) => {
		if (!envSnapshot.has(key)) {
			envSnapshot.set(key, process.env[key]);
		}
		process.env[key] = value;
	};

	afterEach(() => {
		for (const [key, value] of envSnapshot) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		envSnapshot.clear();
	});

	test("uses provider=zai and streams chat completions", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = buildMockFetch(async (input, init) => {
			calls.push({ input, init });
			return new Response(
				sse([
					{
						id: "chatcmpl_zai_1",
						model: "glm-5.2",
						choices: [{ delta: { reasoning_content: "plan " } }],
					},
					{
						id: "chatcmpl_zai_1",
						model: "glm-5.2",
						choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
						usage: {
							prompt_tokens: 8,
							completion_tokens: 2,
							total_tokens: 10,
						},
					},
				]),
				{
					headers: {
						"content-type": "text/event-stream",
						"x-request-id": "req_zai_1",
					},
				},
			);
		});
		const chat = new ChatZai({
			apiKey: "test-zai-key",
			baseURL: "https://example.test/v4/",
			fetch: fetchImpl,
			model: "glm-5.2",
			reasoningEffort: "max",
			reasoningLevelRequested: "xhigh",
			reasoningLevelApplied: "xhigh",
			reasoningFallbackApplied: false,
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "say hello" }],
		});

		expect(chat.provider).toBe("zai");
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe(
			"https://example.test/v4/chat/completions",
		);
		expect(calls[0]?.init?.headers).toMatchObject({
			Authorization: "Bearer test-zai-key",
			"Content-Type": "application/json",
		});
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			model: "glm-5.2",
			stream: true,
			thinking: { type: "enabled" },
			reasoning_effort: "max",
			messages: [{ role: "user", content: "say hello" }],
		});
		expect(completion.messages).toEqual([
			expect.objectContaining({ role: "reasoning", content: "plan " }),
			{ role: "assistant", content: "hello" },
		]);
		expect(completion.usage).toEqual({
			model: "glm-5.2",
			input_tokens: 8,
			output_tokens: 2,
			total_tokens: 10,
		});
		expect(completion.provider_meta).toMatchObject({
			response_id: "chatcmpl_zai_1",
			request_id: "req_zai_1",
			reasoning_requested: "xhigh",
			reasoning_applied: "xhigh",
			reasoning_effort: "max",
			reasoning_fallback: false,
		});
	});

	test("sends tool_stream when tools are present", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = buildMockFetch(async (input, init) => {
			calls.push({ input, init });
			return new Response(
				sse([
					{
						id: "chatcmpl_zai_2",
						model: "glm-5.2",
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: {
												name: "sample_tool",
												arguments: '{"value":"ok"}',
											},
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
					},
				]),
			);
		});
		const chat = new ChatZai({
			apiKey: "test-zai-key",
			fetch: fetchImpl,
		});

		const completion = await chat.ainvoke({
			messages: [{ role: "user", content: "call tool" }],
			tools: [
				{
					name: "sample_tool",
					description: "sample tool",
					parameters: {
						type: "object",
						properties: {
							value: { type: "string" },
						},
					},
				},
			],
			toolChoice: "required",
		});

		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body.tool_stream).toBe(true);
		expect(body.tool_choice).toBe("required");
		expect(body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "sample_tool",
					description: "sample tool",
					parameters: {
						type: "object",
						properties: {
							value: { type: "string" },
						},
					},
				},
			},
		]);
		expect(completion.messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: {
							name: "sample_tool",
							arguments: '{"value":"ok"}',
						},
						provider_meta: expect.objectContaining({
							provider: "zai",
							index: 0,
						}),
					},
				],
			},
		]);
	});

	test("omits reasoning_effort when disabled for non-GLM-5.2 models", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = buildMockFetch(async (input, init) => {
			calls.push({ input, init });
			return new Response(
				sse([
					{
						id: "chatcmpl_zai_51",
						model: "glm-5.1",
						choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
					},
				]),
			);
		});
		const chat = new ChatZai({
			apiKey: "test-zai-key",
			fetch: fetchImpl,
			model: "glm-5.1",
			reasoningEffort: null,
		});

		await chat.ainvoke({
			messages: [{ role: "user", content: "hello" }],
		});

		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body).toMatchObject({
			model: "glm-5.1",
			stream: true,
			thinking: { type: "enabled" },
		});
		expect(body).not.toHaveProperty("reasoning_effort");
	});

	test("provider diagnostics do not log API keys", async () => {
		const dumpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "codelia-zai-log-"),
		);
		const stderrLines: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			stderrLines.push(args.map(String).join(" "));
		};
		setEnv("CODELIA_PROVIDER_LOG", "1");
		setEnv("CODELIA_PROVIDER_LOG_DIR", dumpDir);
		const fetchImpl = buildMockFetch(async () => {
			return new Response(
				sse([
					{
						id: "chatcmpl_zai_log",
						model: "glm-5.2",
						choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
					},
				]),
			);
		});
		try {
			const chat = new ChatZai({
				apiKey: "test-zai-secret-key",
				fetch: fetchImpl,
			});

			await chat.ainvoke({
				messages: [{ role: "user", content: "hello" }],
			});

			const stderr = stderrLines.join("\n");
			expect(stderr).toContain("[zai.request]");
			expect(stderr).toContain("[zai.response]");
			expect(stderr).not.toContain("test-zai-secret-key");
			const files = await fs.readdir(dumpDir);
			expect(files.some((file) => file.includes("_zai_1_request.json"))).toBe(
				true,
			);
			const dumpText = (
				await Promise.all(
					files.map((file) => fs.readFile(path.join(dumpDir, file), "utf8")),
				)
			).join("\n");
			expect(dumpText).toContain('"rawChunks"');
			expect(dumpText).toContain("chatcmpl_zai_log");
			expect(dumpText).not.toContain("test-zai-secret-key");
		} finally {
			console.error = originalError;
			await fs.rm(dumpDir, { recursive: true, force: true });
		}
	});
});
