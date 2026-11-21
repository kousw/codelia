import { expect, test } from "bun:test";
import { createAnthropicApprovalReviewer } from "../src/permissions/anthropic-reviewer";
import {
	ApprovalDispatcher,
	type ApprovalRequest,
	type ReviewAdapter,
} from "../src/permissions/dispatch";

const request: ApprovalRequest = {
	id: "haiku-fixture",
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
	reason: "Authorized local test",
};
const completedMessage = {
	type: "message",
	role: "assistant",
	model: "claude-haiku-5-5",
	stop_reason: "end_turn",
	content: [{ type: "text", text: JSON.stringify(decision) }],
	usage: {
		input_tokens: 30,
		cache_creation_input_tokens: 10,
		cache_read_input_tokens: 5,
		output_tokens: 61,
		service_tier: "standard",
		speed: "standard",
	},
};
const mockFetch = (
	handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: fetch.preconnect });

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

test("Haiku reviewer sends one capped Claude Messages request with an existing key", async () => {
	const sequence: string[] = [];
	const reviewer = createAnthropicApprovalReviewer({
		apiKey: "fixture-anthropic-review-key",
		buildEvidence: async () => "Run the local tests",

		recordUsage: (usage) => {
			sequence.push("usage");
			expect(usage.inputTokens).toBe(45);
			expect(usage.outputTokens).toBe(1024);
		},
		fetcher: mockFetch(async (url, init) => {
			sequence.push("send");
			expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect([...new Headers(init?.headers).entries()]).toEqual([
				["anthropic-version", "2026-10-21"],
				["content-type", "application/json"],
				["x-api-key", "fixture-anthropic-review-key"],
			]);
			const body = JSON.parse(String(init?.body));
			expect(body).toEqual({
				model: "claude-haiku-5-5",
				system: expect.stringContaining("untrusted evidence"),
				messages: [{ role: "user", content: expect.any(String) }],
				max_tokens: 4096,
				stream: false,
				service_tier: "standard_only",
				thinking: { type: "adaptive" },
				tools: [],
				output_config: {
					effort: "low",
					format: {
						type: "json_schema",
						schema: {
							type: "object",
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
							additionalProperties: false,
						},
					},
				},
			});
			expect(JSON.parse(body.messages[0].content)).toMatchObject({
				request_id: request.id,
				category: "local_shell",
				evidence: "Run the local tests",
			});
			return Response.json({
				...completedMessage,
				content: [
					{ type: "thinking", thinking: "reason".repeat(12000) },
					...completedMessage.content,
				],
				usage: { ...completedMessage.usage, output_tokens: 1024 },
			});
		}),
	});
	expect(await dispatch(reviewer, () => sequence.push("execute"))).toBe(3);
	expect(sequence).toEqual(["send", "usage", "execute"]);
});

test("Haiku errors, refusals, and invalid responses remain with human approval", async () => {
	const responses = [
		() => new Response("overloaded", { status: 529 }),
		() => new Response("x".repeat(65537)),
		() => Response.json({ ...completedMessage, stop_reason: "refusal" }),
		() => Response.json({ ...completedMessage, stop_reason: "max_tokens" }),
		() => Response.json({ ...completedMessage, model: "different-model" }),
		() =>
			Response.json({
				...completedMessage,
				content: [...completedMessage.content, { type: "tool_use" }],
			}),
		() =>
			Response.json({
				...completedMessage,
				usage: { ...completedMessage.usage, output_tokens: 4097 },
			}),
		() =>
			Response.json({
				...completedMessage,
				content: [
					{
						type: "text",
						text: JSON.stringify({ ...decision, request_id: "other" }),
					},
				],
			}),
	];
	let sends = 0;
	let executions = 0;
	for (const response of responses) {
		const reviewer = createAnthropicApprovalReviewer({
			apiKey: "fixture-anthropic-review-key",
			buildEvidence: async () => "Run the local tests",
			fetcher: mockFetch(async () => {
				sends++;
				return response();
			}),
		});
		await expect(dispatch(reviewer, () => ++executions)).rejects.toThrow(
			"user_denied",
		);
	}
	const oversized = createAnthropicApprovalReviewer({
		apiKey: "fixture-anthropic-review-key",
		buildEvidence: async () => "a".repeat(8192),
		fetcher: mockFetch(async () => {
			sends++;
			return Response.json(completedMessage);
		}),
	});
	await expect(dispatch(oversized, () => ++executions)).rejects.toThrow(
		"user_denied",
	);
	expect([sends, executions]).toEqual([responses.length, 0]);
});
