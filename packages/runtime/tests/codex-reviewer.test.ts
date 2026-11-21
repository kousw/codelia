import { expect, test } from "bun:test";
import { createCodexApprovalReviewer } from "../src/permissions/codex-reviewer";
import {
	type ApprovalRequest,
	parseApprovalReviewDecision,
} from "../src/permissions/dispatch";

import { readReviewFailure } from "../src/permissions/review-failure";

const id = "codex-fixture";
const packet = JSON.stringify({
	request_id: id,
	evidence: "Run the local tests",
});
const mockFetch = (
	fn: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) => Object.assign(fn, { preconnect: fetch.preconnect }) as typeof fetch;
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const terminal = (
	reply = { request_id: id, decision: "allow_once", reason: "Local intent" },
) =>
	frame({
		type: "response.completed",
		response: {
			status: "completed",
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: JSON.stringify(reply) }],
				},
			],
		},
	});
const auth = {
	token: "fixture-codex-token",
	accountId: "fixture-codex-account",
};
const signal = () => new AbortController().signal;
const request = { id } as ApprovalRequest;

test("Codex OAuth review reads bounded SSE through a terminal event and cancels the remaining body", async () => {
	let cancelled = false;
	const response = new ReadableStream({
		start(controller) {
			const body =
				frame({
					type: "response.created",
					response: { status: "in_progress" },
				}) +
				frame({ type: "response.metadata" }) +
				terminal();
			const bytes = new TextEncoder().encode(body);
			controller.enqueue(bytes.slice(0, 13));
			controller.enqueue(bytes.slice(13));
		},
		cancel() {
			cancelled = true;
		},
	});
	const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
		buildEvidence: async () => null,
		fetcher: mockFetch(async (url, init) => {
			expect(String(url)).toBe(
				"https://chatgpt.com/backend-api/codex/responses",
			);
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bearer fixture-codex-token",
			);
			expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
				"fixture-codex-account",
			);
			expect(JSON.parse(String(init?.body))).toMatchObject({
				model: "gpt-6-luna",
				stream: true,
				store: false,
				tools: [],
				input: [
					{ role: "user", content: [{ type: "input_text", text: packet }] },
				],
				text: { format: { strict: true } },
			});
			return new Response(response, {
				headers: { "content-type": "text/event-stream" },
			});
		}),
	});
	const result = await reviewer.review(packet, signal(), request);
	expect(parseApprovalReviewDecision(result, id)).toBe("allow_once");
	expect(cancelled).toBe(true);
});

test("Codex OAuth review leaves request binding and reason validation to the dispatcher", async () => {
	for (const body of [
		terminal({
			request_id: "other",
			decision: "allow_once",
			reason: "Local intent",
		}),
		terminal({ request_id: id, decision: "allow_once", reason: "" }),
	]) {
		const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
			buildEvidence: async () => null,
			fetcher: mockFetch(
				async () =>
					new Response(body, {
						headers: { "content-type": "text/event-stream" },
					}),
			),
		});
		expect(
			parseApprovalReviewDecision(
				await reviewer.review(packet, signal(), request),
				id,
			),
		).toBeUndefined();
	}
	const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
		buildEvidence: async () => null,
		fetcher: mockFetch(
			async () =>
				new Response("x".repeat(8 * 1024 * 1024 + 1) + terminal(), {
					headers: { "content-type": "text/event-stream" },
				}),
		),
	});
	await expect(reviewer.review(packet, signal(), request)).rejects.toThrow(
		"review_response_too_large",
	);
});

test("Codex OAuth rejects an explicitly incompatible MIME type even with a valid SSE body", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode(terminal()));
		},
		cancel() {
			cancelled = true;
		},
	});
	const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
		buildEvidence: async () => null,
		fetcher: mockFetch(
			async () =>
				new Response(body, {
					headers: { "content-type": "text/html; private=untrusted-header" },
				}),
		),
	});
	const result = await reviewer
		.review(packet, signal(), request)
		.catch((error: unknown) => readReviewFailure(error));
	expect(result).toEqual({
		code: "review_media_type_unexpected",
		httpStatus: 200,
	});
	expect(cancelled).toBe(true);
});

const headerlessBody = (body: string | null): Response =>
	new Response(body === null ? null : new TextEncoder().encode(body));

test.each([
	{ decision: "allow_once", requestId: id, expected: "allow_once" },
	{ decision: "deny", requestId: id, expected: "deny" },
	{ decision: "allow_once", requestId: "wrong-id", expected: undefined },
] as const)(
	"Codex OAuth preserves decision validation for headerless SSE ($decision, $requestId)",
	async ({ decision, requestId, expected }) => {
		let calls = 0;
		const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
			buildEvidence: async () => null,
			fetcher: mockFetch(async () => {
				calls++;
				return headerlessBody(
					": keepalive\n\n" +
						terminal({
							request_id: requestId,
							decision,
							reason: "Local intent",
						}),
				);
			}),
		});
		const result = await reviewer.review(packet, signal(), request);
		expect(parseApprovalReviewDecision(result, id)).toBe(expected);
		expect(calls).toBe(1);
	},
);

test.each([
	{
		body: null,
		diagnostic: { code: "review_media_type_missing", httpStatus: 200 },
	},
	{
		body: "",
		diagnostic: { code: "review_media_type_missing", httpStatus: 200 },
	},
	{
		body: `<html>gateway response</html>\r\n${terminal()}`,
		diagnostic: { code: "review_media_type_missing", httpStatus: 200 },
	},
	{
		body: `data: malformed\n\n${terminal()}`,
		diagnostic: { code: "review_invalid_reply", httpStatus: 200 },
	},
	{
		body: frame({ type: "response.created" }),
		diagnostic: { code: "review_response_incomplete", httpStatus: 200 },
	},
] as const)(
	"Codex OAuth refuses invalid headerless SSE ($diagnostic.code)",
	async ({ body, diagnostic }) => {
		const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
			buildEvidence: async () => null,
			fetcher: mockFetch(async () => headerlessBody(body)),
		});
		const result = await reviewer
			.review(packet, signal(), request)
			.catch((error: unknown) => readReviewFailure(error));
		expect(result).toEqual(diagnostic);
	},
);

test("Codex OAuth cannot approve a headerless response after cancellation", async () => {
	const controller = new AbortController();
	const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
		buildEvidence: async () => null,
		fetcher: mockFetch(async () => {
			controller.abort();
			return headerlessBody(terminal());
		}),
	});
	expect(await reviewer.review(packet, controller.signal, request)).toBeNull();
});

test.each([
	{
		respond: () => new Response(new Uint8Array([0xff])),
		diagnostic: { code: "review_invalid_reply", httpStatus: 200 },
	},
	{
		respond: () => headerlessBody("x".repeat(8 * 1024 * 1024 + 1)),
		diagnostic: { code: "review_response_too_large", httpStatus: 200 },
	},
	{
		respond: () =>
			Object.defineProperty(headerlessBody(terminal()), "redirected", {
				value: true,
			}),
		diagnostic: { code: "review_provider_error", httpStatus: 200 },
	},
] as const)(
	"Codex OAuth preserves transport limits for headerless replies ($diagnostic.code)",
	async ({ respond, diagnostic }) => {
		const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
			buildEvidence: async () => null,
			fetcher: mockFetch(async () => respond()),
		});
		const result = await reviewer
			.review(packet, signal(), request)
			.catch((error: unknown) => readReviewFailure(error));
		expect(result).toEqual(diagnostic);
	},
);

test("Codex OAuth diagnostics retain status and discard HTTP body and transport errors", async () => {
	const cases = [
		{
			fetcher: mockFetch(
				async () => new Response("untrusted-http-body", { status: 429 }),
			),
			diagnostic: { code: "review_rate_limited", httpStatus: 429 },
		},
		{
			fetcher: mockFetch(async () => {
				throw new Error("untrusted-network-error");
			}),
			diagnostic: { code: "review_transport_error" },
		},
		{
			fetcher: mockFetch(
				async () =>
					new Response("data: untrusted-sse-frame\n\n", {
						headers: { "content-type": "text/event-stream" },
					}),
			),
			diagnostic: { code: "review_invalid_reply" },
		},
		{
			fetcher: mockFetch(
				async () =>
					new Response(
						frame({
							type: "response.failed",
							error: { message: "untrusted-provider-error" },
						}) + terminal(),
						{
							headers: { "content-type": "text/event-stream" },
						},
					),
			),
			diagnostic: { code: "review_provider_response_failed" },
		},
		{
			fetcher: mockFetch(
				async () =>
					new Response(
						frame({
							type: "response.incomplete",
							response: { status: "incomplete" },
						}) + terminal(),
						{
							headers: { "content-type": "text/event-stream" },
						},
					),
			),
			diagnostic: { code: "review_response_incomplete" },
		},
		{
			fetcher: mockFetch(
				async () =>
					new Response(
						frame({ type: "response.output_text.delta", delta: "allow_once" }),
						{
							headers: { "content-type": "text/event-stream" },
						},
					),
			),
			diagnostic: { code: "review_response_incomplete" },
		},
	] as const;
	for (const { fetcher, diagnostic } of cases) {
		const reviewer = createCodexApprovalReviewer("gpt-6-luna", auth, {
			buildEvidence: async () => null,
			fetcher,
		});
		const error: unknown = await reviewer
			.review(packet, signal(), request)
			.catch((error: unknown) => error);
		expect(readReviewFailure(error)).toEqual(diagnostic);
		expect(String(error)).toContain(`Error: ${diagnostic.code}:`);
		expect(String(error)).not.toContain("untrusted-");
		expect(error).not.toHaveProperty("cause");
	}
});
