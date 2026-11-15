import type { ProviderName } from "./base";
import {
	asRecord,
	buildProviderFailure,
	isProviderFailureError,
	ProviderFailureError,
} from "./failures";

const responseDetails = {
	invalid_event: "The response stream contained an invalid event.",
	invalid_completion:
		"The provider returned an incomplete or invalid completion record.",
	after_completion: "The provider emitted output after completion.",
	invalid_step_index: "The response stream contained an invalid step index.",
	invalid_step: "The response contained a duplicate or invalid step.",
	out_of_order: "The response stream contained an out-of-order step.",
	invalid_tool_arguments:
		"The response contained incomplete or invalid tool arguments.",
	unsupported_event: "The response stream contained an unsupported event type.",
	invalid_delta: "The response contained an invalid output delta.",
	unsupported_content: "The response contained unsupported content.",
	unsupported_delta: "The response contained an unsupported output delta type.",
	incomplete: "The response stream ended before completion.",
	missing_step: "The response stream omitted a required step.",
	invalid_output: "The response contained invalid model output.",
	nonterminal:
		"The provider response did not complete in a valid terminal state.",
	empty: "The provider returned no model output.",
} as const;

/** Explicitly trusted local diagnostics; never accept a provider message/body here. */
export const createProviderResponseError = (
	provider: ProviderName,
	reason: keyof typeof responseDetails,
): ProviderFailureError =>
	new ProviderFailureError({
		...buildProviderFailure(provider, "provider", { delivery: "buffered" }),
		safeMessage: `${buildProviderFailure(provider, "provider").safeMessage} ${responseDetails[reason]}`,
		code: `response_${reason}`,
		detail: responseDetails[reason],
	});

const transportDetails: Record<string, string> = {
	ECONNRESET: "The remote connection was reset.",
	ECONNREFUSED: "The connection was refused.",
	ENOTFOUND: "The server address could not be resolved by DNS.",
	EAI_AGAIN: "DNS resolution temporarily failed.",
	ETIMEDOUT: "The connection timed out.",
	EPIPE: "The connection closed while sending data.",
	UND_ERR_SOCKET: "The connection closed unexpectedly.",
	UND_ERR_CONNECT_TIMEOUT:
		"The connection timed out before it was established.",
	UND_ERR_HEADERS_TIMEOUT: "The server did not send response headers in time.",
	UND_ERR_BODY_TIMEOUT:
		"The response stream stopped sending data before its timeout.",
	CERT_HAS_EXPIRED: "The TLS certificate has expired.",
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The TLS certificate could not be verified.",
	DEPTH_ZERO_SELF_SIGNED_CERT:
		"The connection used an untrusted self-signed TLS certificate.",
};

/** Retain only allowlisted causes, not raw messages, URLs, IDs, headers or stacks. */
export const safeFailureDiagnostic = (
	error: unknown,
): { code?: string; detail?: string } => {
	const seen = new Set<unknown>();
	for (let depth = 0; error && depth < 5 && !seen.has(error); depth++) {
		seen.add(error);
		if (isProviderFailureError(error) && error.failure.detail)
			return { code: error.failure.code, detail: error.failure.detail };
		const value = asRecord(error);
		const code = typeof value?.code === "string" ? value.code : "";
		if (Object.hasOwn(transportDetails, code))
			return { code, detail: transportDetails[code] };
		error = value?.cause;
	}
	return {};
};
