import { z } from "zod";
import type { ReviewAdapter } from "./dispatch";
import {
	fitsApprovalReviewPacket,
	type PublicApprovalReviewerOptions,
	readBoundedApprovalReviewBody,
	type ReviewerPurpose,
	reviewerWire,
} from "./public-reviewer";
import {
	fetchApprovalReview,
	parseApprovalReviewJson,
} from "./review-transport";

export const xaiApprovalReviewEndpoint = "https://api.x.ai/v1/responses";
export const xaiApprovalReviewModel = "grok-4.7";
export const moonshotApprovalReviewEndpoint =
	"https://api.moonshot.ai/v1/chat/completions";
export const moonshotApprovalReviewModel = "kimi-k3.1-pro";
export const openRouterApprovalReviewEndpoint =
	"https://openrouter.ai/api/v1/chat/completions";
export const openRouterApprovalReviewModel = "openai/gpt-6-luna";
export const openRouterApprovalReviewUpstream = "openai";

const messages = (packet: string, purpose?: ReviewerPurpose) => [
	{ role: "system", content: reviewerWire(purpose).instruction },
	{ role: "user", content: packet },
];
const chatResponseFormat = (purpose?: ReviewerPurpose) => {
	const { type, ...json_schema } = reviewerWire(purpose).format;
	return { type, json_schema };
};
const tokenCount = z.number().int().nonnegative();
const chatUsage = z
	.object({ prompt_tokens: tokenCount, completion_tokens: tokenCount })
	.nullish();
const chatChoice = z.tuple([
	z.object({
		index: z.literal(0),
		finish_reason: z.literal("stop"),
		message: z.object({
			role: z.literal("assistant"),
			content: z.string(),
			refusal: z.null().optional(),
			tool_calls: z.tuple([]).nullish(),
			function_call: z.null().optional(),
		}),
	}),
]);
const moonshotResponse = z.object({
	object: z.literal("chat.completion"),
	model: z.literal(moonshotApprovalReviewModel),
	choices: chatChoice,
	usage: chatUsage,
	error: z.null().optional(),
});
const openRouterServedModel = z.enum([
	openRouterApprovalReviewModel,
	"openai/gpt-6-luna-20260922",
]);
const openRouterUsage = z
	.object({
		prompt_tokens: tokenCount,
		completion_tokens: tokenCount,
		server_tool_use: z.record(z.string(), z.literal(0)).nullish(),
	})
	.nullish();
const openRouterResponse = z.object({
	object: z.literal("chat.completion"),
	model: openRouterServedModel,
	provider: z.literal("OpenAI").optional(),
	service_tier: z.literal("default"),
	choices: chatChoice,
	usage: openRouterUsage,
	error: z.null().optional(),
	openrouter_metadata: z.object({
		requested: z.literal(openRouterApprovalReviewModel),
		strategy: z.literal("direct"),
		attempt: z.literal(1),
		is_byok: z.literal(false),
		endpoints: z.object({
			total: z.literal(1),
			available: z.tuple([
				z.object({
					provider: z.literal("OpenAI"),
					model: openRouterServedModel,
					selected: z.literal(true),
				}),
			]),
		}),
		attempts: z
			.tuple([
				z.object({
					provider: z.literal("OpenAI"),
					model: openRouterServedModel,
					status: z.literal(200),
				}),
			])
			.optional(),
		pipeline: z.array(z.object({ type: z.literal("guardrail") })).optional(),
	}),
});
const xaiResponse = z.object({
	object: z.literal("response"),
	model: z.string().regex(/^grok-4\.7(?:-\d{4}|-\d{8})?$/u),
	status: z.literal("completed"),
	store: z.literal(false),
	error: z.null().optional(),
	incomplete_details: z.null().optional(),
	output: z.array(
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("reasoning") }),
			z.object({
				type: z.literal("message"),
				role: z.literal("assistant"),
				status: z.literal("completed").optional(),
				content: z.tuple([
					z.object({ type: z.literal("output_text"), text: z.string() }),
				]),
			}),
		]),
	),
	usage: z
		.object({ input_tokens: tokenCount, output_tokens: tokenCount })
		.nullish(),
});

type ReviewOutput = {
	text: string;
	usage?: { inputTokens: number; outputTokens: number };
};

const chatOutput = (data: {
	choices: z.infer<typeof chatChoice>;
	usage?: z.infer<typeof chatUsage>;
}): ReviewOutput => ({
	text: data.choices[0].message.content,
	...(data.usage
		? {
				usage: {
					inputTokens: data.usage.prompt_tokens,
					outputTokens: data.usage.completion_tokens,
				},
			}
		: {}),
});

const createJsonApprovalReviewer = (
	{
		endpoint,
		model,
		makeBody,
		parseOutput,
		headers,
	}: {
		endpoint: string;
		model: string;
		makeBody: (packet: string) => object;
		parseOutput: (response: unknown) => ReviewOutput | null;
		headers?: HeadersInit;
	},
	options: PublicApprovalReviewerOptions,
): ReviewAdapter => {
	if (!options.apiKey.trim()) throw new Error("review_api_key_required");
	const eligiblePacket = (packet: string, signal: AbortSignal) =>
		fitsApprovalReviewPacket(packet, signal, options.maxPacketBytes) &&
		!packet.includes(options.apiKey);
	return {
		categories: ["local_shell", "local_test"],
		buildEvidence: options.buildEvidence,
		reserve: eligiblePacket,
		async review(packet, signal, request) {
			if (!eligiblePacket(packet, signal)) return null;
			const start = performance.now();
			const requestHeaders = new Headers(headers);
			requestHeaders.set("Authorization", `Bearer ${options.apiKey}`);
			requestHeaders.set("Content-Type", "application/json");
			const response = await fetchApprovalReview(
				options.fetcher ?? fetch,
				endpoint,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: requestHeaders,
					body: JSON.stringify(makeBody(packet)),
				},
			);
			const output = parseOutput(
				parseApprovalReviewJson(await readBoundedApprovalReviewBody(response)),
			);
			if (signal.aborted || !output) return null;
			if (output.usage)
				options.recordUsage?.({
					model,
					...output.usage,
					durationMs: performance.now() - start,
				});
			const decision = reviewerWire(options.purpose).parse(output.text);
			return !signal.aborted &&
				decision?.request_id === request.id &&
				(!("reason" in decision) || decision.reason.length <= 512)
				? decision
				: null;
		},
	};
};

export const createXaiApprovalReviewer = (
	options: PublicApprovalReviewerOptions,
): ReviewAdapter =>
	createJsonApprovalReviewer(
		{
			endpoint: xaiApprovalReviewEndpoint,
			model: xaiApprovalReviewModel,
			makeBody: (packet) => ({
				model: xaiApprovalReviewModel,
				input: messages(packet, options.purpose),
				store: false,
				stream: false,
				reasoning: { effort: "low" },
				include: ["reasoning.encrypted_content"],
				tools: [],
				tool_choice: "none",

				text: { format: reviewerWire(options.purpose).format },
			}),
			parseOutput: (response) => {
				const parsed = xaiResponse.safeParse(response);
				if (!parsed.success) return null;
				const messages = parsed.data.output.filter(
					(item) => item.type === "message",
				);
				if (messages.length !== 1) return null;
				return {
					text: messages[0].content[0].text,
					...(parsed.data.usage
						? {
								usage: {
									inputTokens: parsed.data.usage.input_tokens,
									outputTokens: parsed.data.usage.output_tokens,
								},
							}
						: {}),
				};
			},
		},
		options,
	);

export const createMoonshotApprovalReviewer = (
	options: PublicApprovalReviewerOptions,
): ReviewAdapter =>
	createJsonApprovalReviewer(
		{
			endpoint: moonshotApprovalReviewEndpoint,
			model: moonshotApprovalReviewModel,
			makeBody: (packet) => ({
				model: moonshotApprovalReviewModel,
				messages: messages(packet, options.purpose),
				stream: false,
				reasoning_effort: "low",

				response_format: chatResponseFormat(options.purpose),
			}),
			parseOutput: (response) => {
				const parsed = moonshotResponse.safeParse(response);
				return parsed.success ? chatOutput(parsed.data) : null;
			},
		},
		options,
	);

export const createOpenRouterApprovalReviewer = (
	options: PublicApprovalReviewerOptions,
): ReviewAdapter =>
	createJsonApprovalReviewer(
		{
			endpoint: openRouterApprovalReviewEndpoint,
			model: openRouterApprovalReviewModel,
			headers: { "X-OpenRouter-Metadata": "enabled" },
			makeBody: (packet) => ({
				model: openRouterApprovalReviewModel,
				messages: messages(packet, options.purpose),
				stream: false,
				service_tier: "default",
				reasoning_effort: "low",
				// The fixed upstream endpoint advertises this parameter in its catalog.

				response_format: chatResponseFormat(options.purpose),
				tools: [],
				tool_choice: "none",
				plugins: [],
				provider: {
					only: [openRouterApprovalReviewUpstream],
					order: [openRouterApprovalReviewUpstream],
					require_parameters: true,
					allow_fallbacks: false,
					data_collection: "deny",
				},
			}),
			parseOutput: (response) => {
				const parsed = openRouterResponse.safeParse(response);
				return parsed.success ? chatOutput(parsed.data) : null;
			},
		},
		options,
	);
