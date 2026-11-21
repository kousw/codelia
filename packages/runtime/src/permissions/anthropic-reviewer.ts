import { z } from "zod";
import type { ReviewAdapter } from "./dispatch";
import {
	fitsApprovalReviewPacket,
	type PublicApprovalReviewerOptions,
	readBoundedApprovalReviewBody,
	reviewerWire,
} from "./public-reviewer";
import {
	fetchApprovalReview,
	parseApprovalReviewJson,
} from "./review-transport";

export const anthropicApprovalReviewEndpoint =
	"https://api.anthropic.com/v1/messages";
export const anthropicApprovalReviewModel = "claude-haiku-5-5";
// Messages requires max_tokens. Match the ordinary ChatAnthropic output default.
const outputLimit = 4096;
const inputLimit = 1_048_576;
const responseShape = z.object({
	type: z.literal("message"),
	role: z.literal("assistant"),
	model: z.literal(anthropicApprovalReviewModel),
	stop_reason: z.string(),
	content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
	usage: z.object({
		input_tokens: z.number().int().nonnegative().max(inputLimit),
		cache_creation_input_tokens: z
			.number()
			.int()
			.nonnegative()
			.max(inputLimit)
			.optional(),
		cache_read_input_tokens: z
			.number()
			.int()
			.nonnegative()
			.max(inputLimit)
			.optional(),
		output_tokens: z.number().int().nonnegative().max(outputLimit),
		service_tier: z.literal("standard").nullish(),
		speed: z.literal("standard").nullish(),
	}),
});

export const createAnthropicApprovalReviewer = (
	options: Omit<PublicApprovalReviewerOptions, "effort">,
): ReviewAdapter => {
	const key = options.apiKey.trim();
	if (!key || /\s/u.test(key)) throw new Error("review_api_key_required");
	const model = anthropicApprovalReviewModel;
	return {
		categories: ["local_shell", "local_test"],
		buildEvidence: options.buildEvidence,
		async review(packet, signal) {
			if (!fitsApprovalReviewPacket(packet, signal) || packet.includes(key))
				return null;
			const start = performance.now();
			const response = await fetchApprovalReview(
				options.fetcher ?? fetch,
				anthropicApprovalReviewEndpoint,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						"x-api-key": key,
						"anthropic-version": "2026-10-21",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model,
						system: reviewerWire(options.purpose).instruction,
						messages: [{ role: "user", content: packet }],
						max_tokens: outputLimit,
						stream: false,
						service_tier: "standard_only",
						thinking: { type: "adaptive" },
						tools: [],
						output_config: {
							effort: "low",
							format: {
								type: "json_schema",
								schema: reviewerWire(options.purpose).schema,
							},
						},
					}),
				},
			);
			const parsed = responseShape.safeParse(
				parseApprovalReviewJson(await readBoundedApprovalReviewBody(response)),
			);
			if (!parsed.success || signal.aborted) return null;
			const { usage, stop_reason, content } = parsed.data;
			const inputTokens =
				usage.input_tokens +
				(usage.cache_creation_input_tokens ?? 0) +
				(usage.cache_read_input_tokens ?? 0);
			if (inputTokens > inputLimit) return null;
			options.recordUsage?.({
				model,
				inputTokens,
				outputTokens: usage.output_tokens,
				durationMs: performance.now() - start,
			});
			if (
				stop_reason !== "end_turn" ||
				content.some(
					(part) =>
						part.type !== "text" &&
						part.type !== "thinking" &&
						part.type !== "redacted_thinking",
				)
			)
				return null;
			const messages = content.filter((part) => part.type === "text");
			const text = messages[0]?.text;
			if (messages.length !== 1 || !text) return null;
			return reviewerWire(options.purpose).parse(text);
		},
	};
};
