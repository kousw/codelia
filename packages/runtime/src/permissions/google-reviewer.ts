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

export const googleApprovalReviewEndpoint =
	"https://generativelanguage.googleapis.com/v1beta/interactions";
export const googleApprovalReviewModel = "gemini-4-hydrogen";
const responseShape = z.object({
	status: z.literal("completed"),
	steps: z.array(
		z.discriminatedUnion("type", [
			z.object({ type: z.literal("thought") }),
			z.object({
				type: z.literal("model_output"),
				content: z.tuple([
					z.object({ type: z.literal("text"), text: z.string() }),
				]),
			}),
		]),
	),
	usage: z
		.object({
			total_input_tokens: z.number().int().nonnegative(),
			total_output_tokens: z.number().int().nonnegative(),
			total_thought_tokens: z.number().int().nonnegative().optional(),
		})
		.optional(),
});

export const createGoogleApprovalReviewer = (
	options: Omit<PublicApprovalReviewerOptions, "effort" | "fetcher">,
): ReviewAdapter => {
	if (!options.apiKey.trim()) throw new Error("review_api_key_required");
	const model = googleApprovalReviewModel;
	return {
		categories: ["local_shell", "local_test"],
		buildEvidence: options.buildEvidence,
		async review(packet, signal) {
			if (
				!fitsApprovalReviewPacket(packet, signal) ||
				packet.includes(options.apiKey)
			)
				return null;
			const start = performance.now();
			const response = await fetchApprovalReview(
				fetch,
				googleApprovalReviewEndpoint,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						"x-goog-api-key": options.apiKey,
						"content-type": "application/json",
						"api-revision": "2026-05-20",
					},
					body: JSON.stringify({
						model,
						input: packet,
						system_instruction: reviewerWire(options.purpose).instruction,
						store: false,
						stream: false,
						generation_config: {
							thinking_level: "low",
						},
						response_format: {
							type: "text",
							mime_type: "application/json",
							schema: reviewerWire(options.purpose).schema,
						},
					}),
				},
			);
			const parsed = responseShape.safeParse(
				parseApprovalReviewJson(await readBoundedApprovalReviewBody(response)),
			);
			if (!parsed.success || signal.aborted) return null;
			const messages = parsed.data.steps.filter(
				(step) => step.type === "model_output",
			);
			if (messages.length !== 1 || messages[0] !== parsed.data.steps.at(-1))
				return null;
			const usage = parsed.data.usage;
			if (usage)
				options.recordUsage?.({
					model,
					inputTokens: usage.total_input_tokens,
					outputTokens:
						usage.total_output_tokens + (usage.total_thought_tokens ?? 0),
					durationMs: performance.now() - start,
				});
			return reviewerWire(options.purpose).parse(messages[0].content[0].text);
		},
	};
};
