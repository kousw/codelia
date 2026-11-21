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

export const deepSeekApprovalReviewEndpoint =
	"https://api.deepseek.com/responses";
export const deepSeekApprovalReviewModel = "deepseek-flash";

const responseShape = z.object({
	object: z.literal("response"),
	model: z.literal(deepSeekApprovalReviewModel),
	status: z.literal("completed"),
	store: z.literal(false).optional(),
	error: z.null().optional(),
	incomplete_details: z.null().optional(),
	output: z.tuple([
		z.object({
			type: z.literal("message"),
			role: z.literal("assistant"),
			status: z.literal("completed"),
			content: z.tuple([
				z.object({ type: z.literal("output_text"), text: z.string() }),
			]),
		}),
	]),
	usage: z
		.object({
			input_tokens: z.number().int().nonnegative(),
			output_tokens: z.number().int().nonnegative(),
		})
		.optional(),
});

export const createDeepSeekApprovalReviewer = (
	options: Pick<
		PublicApprovalReviewerOptions,
		"apiKey" | "purpose" | "buildEvidence" | "recordUsage" | "fetcher"
	>,
): ReviewAdapter => {
	const key = options.apiKey.trim();
	if (!key || /\s/u.test(key)) throw new Error("review_api_key_required");
	return {
		categories: ["local_shell", "local_test"],
		buildEvidence: options.buildEvidence,
		async review(packet, signal) {
			if (!fitsApprovalReviewPacket(packet, signal) || packet.includes(key))
				return null;
			const start = performance.now();
			const response = await fetchApprovalReview(
				options.fetcher ?? fetch,
				deepSeekApprovalReviewEndpoint,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: deepSeekApprovalReviewModel,
						instructions: reviewerWire(options.purpose).instruction,
						input: packet,

						reasoning: { effort: "none" },
						stream: false,
						tools: [],
						tool_choice: "none",
						text: {
							format: {
								type: "json_schema",
								name: reviewerWire(options.purpose).format.name,
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
			const { usage, output } = parsed.data;
			if (usage)
				options.recordUsage?.({
					model: deepSeekApprovalReviewModel,
					inputTokens: usage.input_tokens,
					outputTokens: usage.output_tokens,
					durationMs: performance.now() - start,
				});
			return reviewerWire(options.purpose).parse(output[0].content[0].text);
		},
	};
};
