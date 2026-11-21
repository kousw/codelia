const diagnosticMessages = {
	review_auth: "The review provider's authentication failed.",
	review_authority_changed: "The approval authority changed during review.",
	review_cancelled: "The review was cancelled.",
	review_evidence_credential:
		"The review evidence matches a credential detector.",
	review_evidence_extra_write:
		"Auto approve cannot review shell commands that request additional writable directories.",
	review_evidence_history_unavailable:
		"The runtime could not verify the referenced conversation history.",
	review_evidence_intent_unavailable:
		"The runtime could not find shareable text in the user intent.",
	review_evidence_interactive_stdin:
		"Auto approve requires closed stdin for shell commands.",
	review_evidence_invalid:
		"The runtime could not validate the shell review input.",
	review_evidence_operation_incomplete:
		"The runtime could not determine enough about the shell operation.",
	review_evidence_private_path: "The review evidence matches a private path.",
	review_evidence_scope:
		"The review scope extends beyond the workspace or does not match it.",
	review_evidence_sharing_restricted:
		"The review evidence contains a restriction on external sharing.",
	review_evidence_unsupported_characters:
		"The review evidence contains unsupported control or formatting characters.",
	review_evidence_too_large:
		"The review evidence exceeds the request size limit.",
	review_evidence_unavailable:
		"The runtime could not build shareable review evidence.",
	review_invalid_reply: "The reviewer returned an invalid decision.",
	review_media_type_missing:
		"The review provider omitted the response content type and did not return a recognizable event stream.",
	review_media_type_unexpected:
		"The review provider returned an unexpected content type.",
	review_preparation_failed:
		"The runtime could not prepare the review request.",
	review_provider_error: "The review provider returned an HTTP error.",
	review_provider_response_failed:
		"The provider reported a failed review response.",
	review_rate_limited: "The review provider rate-limited the request.",
	review_response_incomplete:
		"The review provider returned an incomplete response.",
	review_response_missing:
		"The review provider did not return a response body.",
	review_response_too_large: "The review response exceeds the size limit.",
	review_timeout: "The review request timed out.",
	review_transport_error: "The runtime could not reach the review provider.",
	review_unexpected_failure: "The review could not be completed.",
} as const;

export type ReviewDiagnosticCode = keyof typeof diagnosticMessages;

export const isReviewPrivacyFailure = (code: ReviewDiagnosticCode): boolean =>
	code === "review_evidence_credential" ||
	code === "review_evidence_private_path" ||
	code === "review_evidence_sharing_restricted";

const evidenceLocations = {
	shell_request: "shell request",
	shell_analysis: "shell analysis",
	command_source: "shell command source",
	command_executable: "command executable",
	command_arguments: "command arguments",
	shell_options: "shell options",
	parsed_operation: "parsed shell operation",
	working_directory: "working directory",
	reviewed_directory: "reviewed directory",
	write_scope: "workspace write scope",
	user_intent: "user intent",
	user_correction: "user correction",
	earlier_goal_steer: "earlier goal steer",
	historical_user_message: "historical user message",
	historical_proposal: "historical proposal",
	conversation_history: "conversation history",
	reviewer_packet: "review request packet",
} as const;

export type ReviewEvidenceLocation = keyof typeof evidenceLocations;

export type ReviewDiagnostic = Readonly<{
	code: ReviewDiagnosticCode;
	httpStatus?: number;
	location?: ReviewEvidenceLocation;
	position?: number;
}>;

const positionLabels: Partial<Record<ReviewEvidenceLocation, string>> = {
	command_source: "UTF-16 code unit",
	command_arguments: "argument",
	parsed_operation: "operation",
};

export const reviewDiagnostic = (
	code: ReviewDiagnosticCode,
	httpStatus?: number,
	location?: ReviewEvidenceLocation,
	position?: number,
): ReviewDiagnostic =>
	Object.freeze({
		code,
		...(typeof httpStatus === "number" &&
		Number.isInteger(httpStatus) &&
		httpStatus >= 100 &&
		httpStatus <= 599
			? { httpStatus }
			: {}),
		...(typeof location === "string" &&
		Object.hasOwn(evidenceLocations, location)
			? { location }
			: {}),
		...(location &&
		Object.hasOwn(positionLabels, location) &&
		typeof position === "number" &&
		Number.isInteger(position) &&
		position >= 1 &&
		position <= 1_000_000
			? { position }
			: {}),
	});

const locationText = ({ location, position }: ReviewDiagnostic): string => {
	if (location === undefined) return "";
	const label = positionLabels[location];
	const ordinal =
		label && position !== undefined ? ` (${label} ${position})` : "";
	return `Evidence location: ${evidenceLocations[location]}${ordinal}.`;
};

export const reviewDiagnosticText = (diagnostic: ReviewDiagnostic): string =>
	[
		`${diagnostic.code}: ${diagnosticMessages[diagnostic.code]}`,
		locationText(diagnostic),
		diagnostic.httpStatus === undefined
			? ""
			: `(HTTP ${diagnostic.httpStatus})`,
	]
		.filter(Boolean)
		.join(" ");

const controlledFailures = new WeakMap<object, ReviewDiagnostic>();

export class ReviewFailureError extends Error {
	constructor(
		code: ReviewDiagnosticCode,
		httpStatus?: number,
		location?: ReviewEvidenceLocation,
		position?: number,
	) {
		const diagnostic = reviewDiagnostic(
			Object.hasOwn(diagnosticMessages, code)
				? code
				: "review_unexpected_failure",
			httpStatus,
			location,
			position,
		);
		super(reviewDiagnosticText(diagnostic));
		controlledFailures.set(this, diagnostic);
	}
}

export const readReviewFailure = (
	error: unknown,
): ReviewDiagnostic | undefined =>
	error !== null && typeof error === "object"
		? controlledFailures.get(error)
		: undefined;
