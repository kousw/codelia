import { z } from "zod";
import {
	OPENAI_OAUTH_BASE_URL,
	OPENAI_OAUTH_ORIGINATOR,
	OPENAI_OAUTH_USER_AGENT,
} from "../auth/openai-oauth";
import type { ReviewAdapter } from "./dispatch";
import {
	fitsApprovalReviewPacket,
	type PublicApprovalReviewerOptions,
	parseOpenAiReviewResponse,
	readApprovalReviewChunks,
	reviewerWire,
} from "./public-reviewer";
import { ReviewFailureError, readReviewFailure } from "./review-failure";
import {
	fetchApprovalReview,
	parseApprovalReviewJson,
} from "./review-transport";

export const codexReviewEndpoint = `${OPENAI_OAUTH_BASE_URL}/responses`;
const codexReviewEvent = z.object({
	type: z.string(),
	output_index: z.number().int().nonnegative().optional(),
	item: z.unknown().optional(),
	response: z
		.looseObject({ output: z.array(z.unknown()).optional() })
		.optional(),
});

const streamTerminalResponse = async (
	response: Response,
	signal: AbortSignal,
	missingContentType: boolean,
): Promise<unknown> => {
	const missingEventStream = () =>
		new ReviewFailureError("review_media_type_missing", response.status);
	if (missingContentType && !response.body) throw missingEventStream();
	let sawEvent = false;
	let pending = "";
	const items = new Map<number, unknown>();
	for await (const chunk of readApprovalReviewChunks(response)) {
		if (signal.aborted) return null;
		pending += chunk;
		let frame = /\r?\n\r?\n/u.exec(pending);
		while (frame) {
			const block = pending.slice(0, frame.index);
			pending = pending.slice(frame.index + frame[0].length);
			frame = /\r?\n\r?\n/u.exec(pending);
			const lines = block.split(/\r?\n/u);
			// Without the provider's MIME declaration, reject non-SSE text before
			// it can be ignored by the normal frame parser.
			if (
				missingContentType &&
				lines.some(
					(line) =>
						line !== "" && !/^(?::|(?:data|event|id|retry)(?::|$))/u.test(line),
				)
			)
				throw missingEventStream();
			const data = lines
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /u, ""))
				.join("\n");
			if (!data) continue;
			if (data === "[DONE]")
				throw new ReviewFailureError("review_response_incomplete");
			const parsed = codexReviewEvent.safeParse(parseApprovalReviewJson(data));
			if (!parsed.success) throw new ReviewFailureError("review_invalid_reply");
			const event = parsed.data;
			sawEvent = true;
			switch (event.type) {
				case "response.output_item.done":
					if (
						event.output_index === undefined ||
						!event.item ||
						items.has(event.output_index)
					)
						return null;
					items.set(event.output_index, event.item);
					break;
				case "error":
				case "response.failed":
					throw new ReviewFailureError("review_provider_response_failed");
				case "response.incomplete":
					throw new ReviewFailureError("review_response_incomplete");
				case "response.completed":
					if (!event.response) return null;
					return {
						...event.response,
						output: event.response.output?.length
							? event.response.output
							: [...items.entries()]
									.sort(([a], [b]) => a - b)
									.map(([, item]) => item),
					};
			}
		}
	}
	if (missingContentType && !sawEvent) throw missingEventStream();
	throw new ReviewFailureError("review_response_incomplete");
};

export const createCodexApprovalReviewer = (
	model: string,
	auth: { token: string; accountId?: string },
	options: Pick<
		PublicApprovalReviewerOptions,
		"purpose" | "maxPacketBytes" | "buildEvidence" | "recordUsage" | "fetcher"
	>,
): ReviewAdapter => ({
	categories: ["local_shell", "local_test"],
	buildEvidence: options.buildEvidence,
	async review(packet, signal) {
		if (
			!fitsApprovalReviewPacket(packet, signal, options.maxPacketBytes) ||
			packet.includes(auth.token)
		)
			return null;
		const start = performance.now();
		const response = await fetchApprovalReview(
			options.fetcher ?? fetch,
			codexReviewEndpoint,
			{
				method: "POST",
				redirect: "error",
				signal,
				headers: {
					authorization: `Bearer ${auth.token}`,
					"content-type": "application/json",
					accept: "text/event-stream",
					originator: OPENAI_OAUTH_ORIGINATOR,
					"User-Agent": OPENAI_OAUTH_USER_AGENT,
					...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
				},
				body: JSON.stringify({
					model,
					instructions: reviewerWire(options.purpose).instruction,
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: packet }],
						},
					],
					reasoning: { effort: "low" },
					store: false,
					stream: true,
					tools: [],
					parallel_tool_calls: false,
					text: { format: reviewerWire(options.purpose).format },
				}),
			},
		);
		if (signal.aborted) {
			void response.body?.cancel().catch(() => undefined);
			return null;
		}
		const contentType = response.headers.get("content-type");
		if (
			contentType !== null &&
			contentType.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
		) {
			void response.body?.cancel().catch(() => undefined);
			throw new ReviewFailureError(
				"review_media_type_unexpected",
				response.status,
			);
		}
		const terminal = await streamTerminalResponse(
			response,
			signal,
			contentType === null,
		).catch((error: unknown) => {
			const failure = readReviewFailure(error);
			if (contentType === null && failure && failure.httpStatus === undefined)
				throw new ReviewFailureError(failure.code, response.status);
			throw error;
		});
		return parseOpenAiReviewResponse(
			terminal,
			signal,
			(inputTokens, outputTokens) =>
				options.recordUsage?.({
					model,
					inputTokens,
					outputTokens,
					durationMs: performance.now() - start,
				}),
			options.purpose,
		);
	},
});
