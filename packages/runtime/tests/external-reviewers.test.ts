import { expect, test } from "bun:test";
import type { ApprovalRequest } from "../src/permissions/dispatch";
import {
	createMoonshotApprovalReviewer,
	createOpenRouterApprovalReviewer,
	createXaiApprovalReviewer,
	moonshotApprovalReviewEndpoint,
	moonshotApprovalReviewModel,
	openRouterApprovalReviewEndpoint,
	openRouterApprovalReviewModel,
	xaiApprovalReviewEndpoint,
	xaiApprovalReviewModel,
} from "../src/permissions/external-reviewers";
import { approvalReviewInstruction } from "../src/permissions/public-reviewer";

const request: ApprovalRequest = {
	id: "request",
	owner: "fixture",
	origin: "parent_agent",
	subject: "shell",
	registration: "builtin.shell/1",
	input: "{}",
	authorityVersion: "fixture",
	intentVersion: "fixture",
	connectionGeneration: "fixture",
};
const packet = JSON.stringify({
	request_id: request.id,
	phase: "pre_launch",
	category: "local_test",
	evidence: "Run the tests locally.",
});
const apiKey = "fixture-review-api-key";
const decision = {
	request_id: request.id,
	decision: "allow_once",
	reason: "Matches the request.",
};
const chatResult = (model: string, choice: Record<string, unknown> = {}) => ({
	object: "chat.completion",
	model,
	choices: [
		{
			index: 0,
			finish_reason: "stop",
			message: {
				role: "assistant",
				content: JSON.stringify(decision),
				reasoning_content: "Ignored reasoning, never used as a decision.",
			},
			...choice,
		},
	],
	usage: { prompt_tokens: 191, completion_tokens: 68 },
});
const routeProof = {
	requested: openRouterApprovalReviewModel,
	strategy: "direct",
	attempt: 1,
	is_byok: false,
	endpoints: {
		total: 1,
		available: [
			{
				provider: "OpenAI",
				model: openRouterApprovalReviewModel,
				selected: true,
			},
		],
	},
};
const gatewayResult = () => ({
	...chatResult(openRouterApprovalReviewModel),
	provider: "OpenAI",
	service_tier: "default",
	openrouter_metadata: routeProof,
});
const xaiResult = () => ({
	object: "response",
	model: xaiApprovalReviewModel,
	status: "completed",
	store: false,
	output: [
		{ type: "reasoning", encrypted_content: "opaque" },
		{
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: JSON.stringify(decision) }],
		},
	],
	usage: { input_tokens: 191, output_tokens: 68 },
});

const fixture = (
	endpoint: string,
	result: unknown,
	checkBody?: (body: Record<string, unknown>, headers: Headers) => void,
) => {
	const signal = new AbortController().signal;
	let calls = 0;
	const usages: unknown[] = [];
	const fetcher = (async (url, init) => {
		calls++;
		expect(url).toBe(endpoint);
		expect(init?.method).toBe("POST");
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBe(signal);
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe(`Bearer ${apiKey}`);
		checkBody?.(JSON.parse(String(init?.body)), headers);
		return Response.json(result);
	}) as typeof fetch;
	return {
		options: {
			apiKey,
			buildEvidence: async () => null,
			fetcher,
			recordUsage: (usage: unknown) => usages.push(usage),
		},
		signal,
		calls: () => calls,
		usages,
	};
};

test("Grok uses non-streaming Responses with explicit storage and tool controls", async () => {
	const testApi = fixture(xaiApprovalReviewEndpoint, xaiResult(), (body) => {
		expect(body).toMatchObject({
			model: xaiApprovalReviewModel,
			input: [
				{ role: "system", content: approvalReviewInstruction },
				{ role: "user", content: packet },
			],
			store: false,
			stream: false,
			reasoning: { effort: "low" },
			include: ["reasoning.encrypted_content"],
			tools: [],
			tool_choice: "none",

			text: { format: { type: "json_schema", strict: true } },
		});
		expect(body.previous_response_id).toBeUndefined();
	});
	const adapter = createXaiApprovalReviewer(testApi.options);
	expect(testApi.calls()).toBe(0);
	expect(await adapter.review(packet, testApi.signal, request)).toEqual(
		decision,
	);
	expect(testApi.calls()).toBe(1);
	expect(testApi.usages).toEqual([
		expect.objectContaining({
			model: xaiApprovalReviewModel,
			inputTokens: 191,
			outputTokens: 68,
		}),
	]);
});

test("Kimi uses strict schema on final Chat Completions content", async () => {
	const testApi = fixture(
		moonshotApprovalReviewEndpoint,
		chatResult(moonshotApprovalReviewModel),
		(body) => {
			expect(body).toMatchObject({
				model: moonshotApprovalReviewModel,
				messages: [
					{ role: "system", content: approvalReviewInstruction },
					{ role: "user", content: packet },
				],
				stream: false,
				reasoning_effort: "low",

				response_format: { type: "json_schema", json_schema: { strict: true } },
			});
			expect(body.tools).toBeUndefined();
			expect(body.temperature).toBeUndefined();
		},
	);
	const adapter = createMoonshotApprovalReviewer(testApi.options);
	expect(await adapter.review(packet, testApi.signal, request)).toEqual(
		decision,
	);
	expect(testApi.calls()).toBe(1);
	expect(testApi.usages).toEqual([
		expect.objectContaining({
			model: moonshotApprovalReviewModel,
			inputTokens: 191,
			outputTokens: 68,
		}),
	]);
});

test("OpenRouter fixes one compatible OpenAI route and checks the routing metadata", async () => {
	const testApi = fixture(
		openRouterApprovalReviewEndpoint,
		gatewayResult(),
		(body, headers) => {
			expect(headers.get("X-OpenRouter-Metadata")).toBe("enabled");
			expect(body).toMatchObject({
				model: openRouterApprovalReviewModel,
				provider: {
					only: ["openai"],
					order: ["openai"],
					require_parameters: true,
					allow_fallbacks: false,
					data_collection: "deny",
				},
				service_tier: "default",

				plugins: [],
				tools: [],
				tool_choice: "none",
				stream: false,
				response_format: { type: "json_schema", json_schema: { strict: true } },
			});
			expect(body.models).toBeUndefined();
		},
	);
	const adapter = createOpenRouterApprovalReviewer(testApi.options);
	expect(await adapter.review(packet, testApi.signal, request)).toEqual(
		decision,
	);
	expect(testApi.calls()).toBe(1);
});

test.each([
	{ openrouter_metadata: undefined },
	{ openrouter_metadata: { ...routeProof, attempt: 2 } },
	{ openrouter_metadata: { ...routeProof, is_byok: true } },
	{ openrouter_metadata: { ...routeProof, strategy: "fallback" } },
	{
		openrouter_metadata: {
			...routeProof,
			pipeline: [{ type: "context_compression" }],
		},
	},
	{
		openrouter_metadata: {
			...routeProof,
			endpoints: { ...routeProof.endpoints, total: 2 },
		},
	},
	{
		openrouter_metadata: {
			...routeProof,
			endpoints: {
				total: 1,
				available: [
					{
						provider: "Azure",
						model: openRouterApprovalReviewModel,
						selected: true,
					},
				],
			},
		},
	},
	{ provider: "Azure" },
	{
		usage: {
			prompt_tokens: 20,
			completion_tokens: 10,
			server_tool_use: { web_search_requests: 1 },
		},
	},
	{ service_tier: "priority" },
	{ model: "openai/gpt-6-sol" },
])(
	"OpenRouter rejects unsupported or missing routing evidence %#",
	async (change) => {
		const testApi = fixture(openRouterApprovalReviewEndpoint, {
			...gatewayResult(),
			...change,
		});
		const adapter = createOpenRouterApprovalReviewer(testApi.options);
		expect(await adapter.review(packet, testApi.signal, request)).toBeNull();
		expect(testApi.calls()).toBe(1);
	},
);

test("incomplete, unbound or extra output cannot become a review decision", async () => {
	const cases = [
		{
			create: createMoonshotApprovalReviewer,
			endpoint: moonshotApprovalReviewEndpoint,
			result: chatResult(moonshotApprovalReviewModel, {
				finish_reason: "length",
			}),
		},
		{
			create: createMoonshotApprovalReviewer,
			endpoint: moonshotApprovalReviewEndpoint,
			result: chatResult(moonshotApprovalReviewModel, {
				message: {
					role: "assistant",
					content: JSON.stringify({ ...decision, request_id: "different" }),
				},
			}),
		},
		{
			create: createOpenRouterApprovalReviewer,
			endpoint: openRouterApprovalReviewEndpoint,
			result: {
				...gatewayResult(),
				choices: chatResult(openRouterApprovalReviewModel, {
					message: {
						role: "assistant",
						content: JSON.stringify({ ...decision, grant: "persist" }),
					},
				}).choices,
			},
		},
		{
			create: createXaiApprovalReviewer,
			endpoint: xaiApprovalReviewEndpoint,
			result: { ...xaiResult(), store: true },
		},
		{
			create: createXaiApprovalReviewer,
			endpoint: xaiApprovalReviewEndpoint,
			result: { ...xaiResult(), model: "grok-4.6" },
		},
		{
			create: createXaiApprovalReviewer,
			endpoint: xaiApprovalReviewEndpoint,
			result: {
				...xaiResult(),
				output: [...xaiResult().output, { type: "function_call" }],
			},
		},
	];
	for (const { create, endpoint, result } of cases) {
		const testApi = fixture(endpoint, result);
		expect(
			await create(testApi.options).review(packet, testApi.signal, request),
		).toBeNull();
	}
});

test("oversized, cancelled or credential-bearing packets do not send any request", async () => {
	for (const create of [
		createXaiApprovalReviewer,
		createMoonshotApprovalReviewer,
		createOpenRouterApprovalReviewer,
	]) {
		let sent = 0;
		const adapter = create({
			apiKey,
			buildEvidence: async () => null,
			fetcher: (async (_url, _init) => {
				sent++;
				return new Response(null, { status: 500 });
			}) as typeof fetch,
		});
		const signal = new AbortController().signal;
		expect(await adapter.review("あ".repeat(2731), signal, request)).toBeNull();
		expect(
			await adapter.review(packet, AbortSignal.abort(), request),
		).toBeNull();
		expect(
			await adapter.review(JSON.stringify({ secret: apiKey }), signal, request),
		).toBeNull();
		expect(
			await adapter.review(
				JSON.stringify({ secret: `sk-${"x".repeat(24)}` }),
				signal,
				request,
			),
		).toBeNull();
		expect(sent).toBe(0);
	}
});
