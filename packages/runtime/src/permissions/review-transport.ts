import {
	type ReviewDiagnosticCode,
	ReviewFailureError,
} from "./review-failure";

function httpReviewFailureCode(status: number): ReviewDiagnosticCode {
	switch (status) {
		case 401:
		case 403:
			return "review_auth";
		case 429:
			return "review_rate_limited";
		case 408:
		case 504:
			return "review_timeout";
		default:
			return "review_provider_error";
	}
}

export async function fetchApprovalReview(
	fetcher: typeof fetch,
	endpoint: string,
	init: RequestInit,
): Promise<Response> {
	let response: Response;
	try {
		response = await fetcher(endpoint, init);
	} catch {
		throw new ReviewFailureError("review_transport_error");
	}
	if (!response.ok || response.redirected) {
		void response.body?.cancel().catch(() => undefined);
		throw new ReviewFailureError(
			httpReviewFailureCode(response.status),
			response.status,
		);
	}
	return response;
}

export function parseApprovalReviewJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		throw new ReviewFailureError("review_invalid_reply");
	}
}
