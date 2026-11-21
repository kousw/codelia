import { z } from "zod";
import type { ReviewAdapter } from "./dispatch";
import {
	approvalReviewInstruction,
	fitsApprovalReviewPacket,
	type PublicApprovalReviewerOptions,
	readBoundedApprovalReviewBody,
	reviewerWire,
} from "./public-reviewer";
import {
	fetchApprovalReview,
	parseApprovalReviewJson,
} from "./review-transport";

export const zaiApprovalReviewEndpoint =
	"https://api.z.ai/api/paas/v4/chat/completions";
export const zaiApprovalReviewModel = "glm-5.3";

const jsonInstruction = [
	approvalReviewInstruction,
	'Respond with one JSON object with exactly the keys "request_id", "decision", and "reason".',
	'All values must be strings. The only valid decisions are "allow_once", "deny", "insufficient_evidence", and "ask_user".',
].join(" ");
const responseShape = z.object({
	model: z.literal(zaiApprovalReviewModel),
	web_search: z.tuple([]).nullish(),
	choices: z.tuple([
		z.object({
			index: z.literal(0),
			finish_reason: z.literal("stop"),
			message: z.object({
				role: z.literal("assistant"),
				content: z.string(),
				tool_calls: z.tuple([]).nullish(),
			}),
		}),
	]),
	usage: z
		.object({
			prompt_tokens: z.number().int().nonnegative(),
			completion_tokens: z.number().int().nonnegative(),
		})
		.optional(),
});

export const createZaiApprovalReviewer = (
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
				zaiApprovalReviewEndpoint,
				{
					method: "POST",
					redirect: "error",
					signal,
					headers: {
						authorization: `Bearer ${key}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: zaiApprovalReviewModel,
						messages: [
							{
								role: "system",
								content: options.purpose
									? reviewerWire(options.purpose).instruction
									: jsonInstruction,
							},
							{ role: "user", content: packet },
						],
						thinking: { type: "enabled" },
						reasoning_effort: "low",

						stream: false,
						response_format: { type: "json_object" },
					}),
				},
			);
			const parsed = responseShape.safeParse(
				parseApprovalReviewJson(await readBoundedApprovalReviewBody(response)),
			);
			if (!parsed.success || signal.aborted) return null;
			const { usage, choices } = parsed.data;
			if (usage)
				options.recordUsage?.({
					model: zaiApprovalReviewModel,
					inputTokens: usage.prompt_tokens,
					outputTokens: usage.completion_tokens,
					durationMs: performance.now() - start,
				});
			return reviewerWire(options.purpose).parse(choices[0].message.content);
		},
	};
};
