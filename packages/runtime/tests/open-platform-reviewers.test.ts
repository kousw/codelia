import { expect, test } from "bun:test";
import { createDeepSeekApprovalReviewer } from "../src/permissions/deepseek-reviewer";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
	type ReviewAdapter,
} from "../src/permissions/dispatch";
import { createZaiApprovalReviewer } from "../src/permissions/zai-reviewer";

const request: ApprovalRequest = {
	id: "review-fixture",
	owner: "fixture",
	origin: "parent_agent",
	subject: "shell",
	registration: "builtin.shell/1",
	input: "{}",
	authorityVersion: "1",
	intentVersion: "1",
	connectionGeneration: "1",
};
const decision = {
	request_id: request.id,
	decision: "allow_once",
	reason: "Local test matches the request",
};
const deepSeekMessage = {
	type: "message",
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text: JSON.stringify(decision) }],
};
const deepSeekReply = {
	object: "response",
	model: "deepseek-flash",
	status: "completed",
	output: [deepSeekMessage],
	error: null,
	incomplete_details: null,
	usage: { input_tokens: 134, output_tokens: 45 },
};
const zaiMessage = {
	role: "assistant",
	content: JSON.stringify(decision),
	reasoning_content: "Unused by the client",
};
const zaiChoice = { index: 0, finish_reason: "stop", message: zaiMessage };
const zaiReply = {
	model: "glm-5.3",
	choices: [zaiChoice],
	usage: { prompt_tokens: 134, completion_tokens: 45 },
};
const mockFetch = (
	handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });
const evidence = "Run the local test.";
const key = "fixture-platform-review-key";

const dispatch = (review: ReviewAdapter, execute: () => number) =>
	new ApprovalDispatcher({
		review,
		confirmation: {
			confirm: async ({ requestId }) => ({
				requestId,
				choice: "deny_continue",
			}),
		},
	}).dispatch({
		request,
		evaluate: () => ({
			valid: true,
			owned: true,
			enforceable: true,
			registered: true,
			profile: "development",
			requested: [],
			granted: [],
			ceiling: [],
			reviewCategory: "local_test",
		}),
		stillCurrent: () => true,
		preview: () => "bun test",
		execute,
	});

const providers = [
	{
		reviewer: createDeepSeekApprovalReviewer,
		name: "DeepSeek Flash",
		url: "https://api.deepseek.com/responses",
		response: deepSeekReply,
		expectedBody: {
			model: "deepseek-flash",
			instructions: expect.stringContaining("untrusted evidence"),
			input: expect.any(String),

			reasoning: { effort: "none" },
			stream: false,
			tools: [],
			tool_choice: "none",
			text: {
				format: {
					type: "json_schema",
					name: "approval_decision",
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["request_id", "decision", "reason"],
						properties: {
							request_id: { type: "string" },
							decision: {
								type: "string",
								enum: [
									"allow_once",
									"deny",
									"insufficient_evidence",
									"ask_user",
								],
							},
							reason: { type: "string" },
						},
					},
				},
			},
		},
		rejectedReplies: [
			{ ...deepSeekReply, status: "incomplete" },
			{ ...deepSeekReply, store: true },
			{
				...deepSeekReply,
				output: [{ ...deepSeekMessage, status: "in_progress" }],
			},
			{
				...deepSeekReply,
				output: [{ type: "function_call" }, deepSeekMessage],
			},
			{
				...deepSeekReply,
				output: [
					{
						...deepSeekMessage,
						content: [
							{
								type: "output_text",
								text: JSON.stringify({ ...decision, untrusted: true }),
							},
						],
					},
				],
			},
		],
	},
	{
		reviewer: createZaiApprovalReviewer,
		name: "Z.ai GLM-5.3",
		url: "https://api.z.ai/api/paas/v4/chat/completions",
		response: zaiReply,
		expectedBody: {
			model: "glm-5.3",
			messages: [
				{
					role: "system",
					content: expect.stringContaining(
						'exactly the keys "request_id", "decision", and "reason"',
					),
				},
				{ role: "user", content: expect.any(String) },
			],
			thinking: { type: "enabled" },
			reasoning_effort: "low",

			stream: false,
			response_format: { type: "json_object" },
		},
		rejectedReplies: [
			{ ...zaiReply, choices: [{ ...zaiChoice, finish_reason: "length" }] },
			{
				...zaiReply,
				choices: [
					{
						...zaiChoice,
						message: { ...zaiMessage, tool_calls: [{ name: "tool" }] },
					},
				],
			},
			{
				...zaiReply,
				choices: [
					{
						...zaiChoice,
						message: {
							...zaiMessage,
							content: JSON.stringify({ ...decision, request_id: "other" }),
						},
					},
				],
			},
			{
				...zaiReply,
				choices: [
					{
						...zaiChoice,
						message: {
							...zaiMessage,
							content: JSON.stringify({ ...decision, unexpected: true }),
						},
					},
				],
			},
		],
	},
];

for (const provider of providers) {
	test(`${provider.name} sends one bounded request to its fixed public API with the supplied key`, async () => {
		let sent = 0;
		let usages = 0;
		const reviewer = provider.reviewer({
			apiKey: key,
			buildEvidence: async () => evidence,
			recordUsage: (usage) => {
				usages++;
				expect(usage).toMatchObject({
					model: provider.response.model,
					inputTokens: 134,
					outputTokens: 45,
				});
			},
			fetcher: mockFetch(async (url, init) => {
				sent++;
				expect(String(url)).toBe(provider.url);
				expect(init?.method).toBe("POST");
				expect(init?.redirect).toBe("error");
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				expect([...new Headers(init?.headers).entries()]).toEqual([
					["authorization", `Bearer ${key}`],
					["content-type", "application/json"],
				]);
				const body = JSON.parse(String(init?.body));
				expect(body).toEqual(provider.expectedBody);
				expect(
					JSON.parse(body.input ?? body.messages[1].content),
				).toMatchObject({
					request_id: request.id,
					category: "local_shell",
					evidence,
				});
				return Response.json(provider.response);
			}),
		});
		expect(await dispatch(reviewer, () => 1)).toBe(1);
		expect([sent, usages]).toEqual([1, 1]);
	});

	test(`${provider.name} returns errors and invalid approvals to the user`, async () => {
		let sent = 0;
		let executed = 0;
		const replies = [
			...provider.rejectedReplies.map((reply) => Response.json(reply)),
			Response.json({ ...provider.response, model: "other-model" }),
			new Response("busy", { status: 429 }),
			new Response("x".repeat(65537)),
		];
		const reviewer = provider.reviewer({
			apiKey: key,
			buildEvidence: async () => evidence,
			fetcher: mockFetch(async () => replies[sent++]),
		});
		for (const _reply of replies)
			await expect(dispatch(reviewer, () => ++executed)).rejects.toThrow(
				"user_denied",
			);
		const signal = new AbortController().signal;
		expect(
			await reviewer.review("あ".repeat(2731), signal, request),
		).toBeNull();
		expect(await reviewer.review(key, signal, request)).toBeNull();
		expect([sent, executed]).toEqual([replies.length, 0]);
	});
}
