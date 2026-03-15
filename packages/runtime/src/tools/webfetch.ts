import type { Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 200_000;
const MAX_MAX_BYTES = 1_000_000;

type OutputFormat = "markdown" | "text" | "html";
type WebfetchErrorKind =
	| "timeout"
	| "dns_error"
	| "tls_error"
	| "connection_refused"
	| "connection_reset"
	| "network_error";

const TLS_ERROR_CODES = new Set([
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"CERT_HAS_EXPIRED",
	"CERT_NOT_YET_VALID",
]);

const normalizeWhitespace = (value: string): string =>
	value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

const decodeHtmlEntities = (value: string): string =>
	value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");

const htmlToText = (html: string): string => {
	const withoutScripts = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const withBreaks = withoutScripts
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/(p|div|section|article|header|footer|main|aside|nav|tr|table|ul|ol|li|h[1-6])>/gi,
			"\n",
		)
		.replace(/<(li)[^>]*>/gi, "- ");
	const stripped = withBreaks.replace(/<[^>]+>/g, " ");
	return normalizeWhitespace(decodeHtmlEntities(stripped));
};

const htmlToMarkdown = (html: string): string => {
	const withoutScripts = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const linked = withoutScripts.replace(
		/<a\s+[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
		(_match, _quote, href: string, text: string) => {
			const label = htmlToText(text) || href;
			return `[${label}](${href})`;
		},
	);
	const headed = linked
		.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, text: string) => {
			return `# ${htmlToText(text)}\n\n`;
		})
		.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, text: string) => {
			return `## ${htmlToText(text)}\n\n`;
		})
		.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, text: string) => {
			return `### ${htmlToText(text)}\n\n`;
		})
		.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, text: string) => {
			return `- ${htmlToText(text)}\n`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(
			/<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol)>/gi,
			"\n\n",
		);
	return normalizeWhitespace(
		decodeHtmlEntities(headed.replace(/<[^>]+>/g, " ")),
	);
};

const isTextualContentType = (contentType: string): boolean => {
	const normalized = contentType.toLowerCase();
	if (!normalized) return true;
	if (normalized.startsWith("text/")) return true;
	if (normalized.includes("json")) return true;
	if (normalized.includes("xml")) return true;
	if (normalized.includes("javascript")) return true;
	if (normalized.includes("xhtml")) return true;
	if (normalized.includes("svg")) return true;
	if (normalized.includes("markdown")) return true;
	if (normalized.includes("yaml")) return true;
	if (normalized.includes("x-www-form-urlencoded")) return true;
	return false;
};

const looksBinaryBuffer = (buffer: Buffer): boolean => {
	if (buffer.length === 0) return false;
	let suspicious = 0;
	const sample = Math.min(buffer.length, 512);
	for (let index = 0; index < sample; index += 1) {
		const byte = buffer[index] ?? 0;
		if (byte === 0) {
			return true;
		}
		const isControl =
			byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
		if (isControl) {
			suspicious += 1;
		}
	}
	return suspicious / sample > 0.1;
};

const readResponseBody = async (
	response: Response,
	maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean; byteSize: number }> => {
	const contentLength = Number(response.headers.get("content-length"));
	if (!response.body) {
		const buffer = Buffer.from(await response.arrayBuffer());
		if (buffer.byteLength <= maxBytes) {
			return { buffer, truncated: false, byteSize: buffer.byteLength };
		}
		const truncated = buffer.subarray(0, maxBytes);
		return {
			buffer: truncated,
			truncated: true,
			byteSize: Number.isFinite(contentLength)
				? contentLength
				: buffer.byteLength,
		};
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (total + value.byteLength > maxBytes) {
			const remaining = maxBytes - total;
			if (remaining > 0) {
				chunks.push(value.slice(0, remaining));
				total += remaining;
			}
			truncated = true;
			await reader.cancel();
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
	return {
		buffer: combined,
		truncated,
		byteSize:
			Number.isFinite(contentLength) && contentLength > total
				? contentLength
				: total,
	};
};

const looksLikeHtml = (contentType: string, text: string): boolean =>
	contentType.includes("text/html") || /<html[\s>]|<!doctype html/i.test(text);

const extractCharset = (contentType: string): string | null => {
	const match = /charset\s*=\s*("?)([^;"\s]+)\1/i.exec(contentType);
	if (!match) return null;
	const charset = match[2]?.trim();
	return charset ? charset : null;
};

const decodeBuffer = (buffer: Buffer, contentType: string): string => {
	const charset = extractCharset(contentType);
	if (charset) {
		try {
			return new TextDecoder(charset).decode(buffer);
		} catch {
			// Fall through to UTF-8 when the label is unsupported.
		}
	}
	return buffer.toString("utf8");
};

const extractTitle = (html: string): string | undefined => {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = htmlToText(match[1] ?? "");
	return title || undefined;
};

const describeUnknownError = (error: unknown): string => {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
};

const extractNestedCode = (error: unknown): string | null => {
	if (!error || typeof error !== "object") return null;
	const direct = (error as { code?: unknown }).code;
	if (typeof direct === "string" && direct.trim().length > 0) {
		return direct.trim();
	}
	const cause = (error as { cause?: unknown }).cause;
	if (!cause || typeof cause !== "object") return null;
	const causeCode = (cause as { code?: unknown }).code;
	if (typeof causeCode === "string" && causeCode.trim().length > 0) {
		return causeCode.trim();
	}
	return null;
};

const extractNestedMessage = (error: unknown): string | null => {
	if (!error || typeof error !== "object") return null;
	const cause = (error as { cause?: unknown }).cause;
	if (!cause || typeof cause !== "object") return null;
	const causeMessage = (cause as { message?: unknown }).message;
	if (typeof causeMessage === "string" && causeMessage.trim().length > 0) {
		return causeMessage.trim();
	}
	return null;
};

const compactFetchErrorDetail = (options: {
	kind: WebfetchErrorKind;
	rawMessage: string;
	code: string | null;
	causeMessage: string | null;
}): string => {
	const genericMessage =
		options.rawMessage.trim().length === 0 ||
		options.rawMessage.trim().toLowerCase() === "fetch failed";
	const causeText =
		options.causeMessage &&
		options.causeMessage.toLowerCase() !== "fetch failed"
			? options.causeMessage
			: null;
	const primary = !genericMessage
		? options.rawMessage.trim()
		: (causeText ??
			(options.kind === "tls_error"
				? "certificate validation failed"
				: options.kind === "dns_error"
					? "dns lookup failed"
					: options.kind === "connection_refused"
						? "connection refused"
						: options.kind === "connection_reset"
							? "connection reset"
							: "network request failed"));
	return options.code ? `${primary} (code=${options.code})` : primary;
};

const classifyFetchError = (
	error: unknown,
	timeoutMs: number,
): { kind: WebfetchErrorKind; detail: string } => {
	if ((error as Error | undefined)?.name === "AbortError") {
		return {
			kind: "timeout",
			detail: `timed out after ${timeoutMs}ms`,
		};
	}

	const rawMessage = describeUnknownError(error);
	const message = rawMessage.toLowerCase();
	const code = extractNestedCode(error)?.toUpperCase() ?? null;
	const causeMessage = extractNestedMessage(error);

	if (
		code === "ENOTFOUND" ||
		code === "EAI_AGAIN" ||
		message.includes("getaddrinfo") ||
		message.includes("dns")
	) {
		return {
			kind: "dns_error",
			detail: compactFetchErrorDetail({
				kind: "dns_error",
				rawMessage,
				code,
				causeMessage,
			}),
		};
	}
	if (code === "ECONNREFUSED" || message.includes("connection refused")) {
		return {
			kind: "connection_refused",
			detail: compactFetchErrorDetail({
				kind: "connection_refused",
				rawMessage,
				code,
				causeMessage,
			}),
		};
	}
	if (
		code === "ECONNRESET" ||
		code === "EPIPE" ||
		message.includes("socket hang up") ||
		message.includes("connection reset")
	) {
		return {
			kind: "connection_reset",
			detail: compactFetchErrorDetail({
				kind: "connection_reset",
				rawMessage,
				code,
				causeMessage,
			}),
		};
	}
	if (
		(code?.startsWith("CERT_") ?? false) ||
		(code?.startsWith("ERR_TLS_") ?? false) ||
		(code !== null && TLS_ERROR_CODES.has(code)) ||
		(code?.startsWith("ERR_SSL_") ?? false) ||
		message.includes("tls") ||
		message.includes("certificate") ||
		message.includes("ssl")
	) {
		return {
			kind: "tls_error",
			detail: compactFetchErrorDetail({
				kind: "tls_error",
				rawMessage,
				code,
				causeMessage,
			}),
		};
	}
	return {
		kind: "network_error",
		detail: compactFetchErrorDetail({
			kind: "network_error",
			rawMessage,
			code,
			causeMessage,
		}),
	};
};

export const createWebfetchTool = (): Tool =>
	defineTool({
		name: "webfetch",
		description:
			"Fetch an HTTP(S) URL and return bounded normalized markdown/text/html for textual content, not binary downloads.",
		input: z.object({
			url: z.string().min(1).describe("HTTP(S) URL to fetch."),
			output_format: z
				.enum(["markdown", "text", "html"])
				.optional()
				.describe("Normalized output format. Default markdown."),
			timeout_ms: z
				.number()
				.int()
				.positive()
				.max(MAX_TIMEOUT_MS)
				.optional()
				.describe(`Fetch timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, Max ${MAX_TIMEOUT_MS}.`),
			max_bytes: z
				.number()
				.int()
				.positive()
				.max(MAX_MAX_BYTES)
				.optional()
				.describe(`Max response bytes to keep. Default ${DEFAULT_MAX_BYTES}, Max ${MAX_MAX_BYTES}.`),
		}),
		execute: async (input) => {
			let url: URL;
			try {
				url = new URL(input.url);
			} catch {
				return `Invalid URL: ${input.url}`;
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return `Unsupported URL protocol: ${url.protocol}`;
			}

			const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
			const maxBytes = input.max_bytes ?? DEFAULT_MAX_BYTES;
			const outputFormat: OutputFormat = input.output_format ?? "markdown";
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);

			try {
				const response = await fetch(url, {
					redirect: "follow",
					signal: controller.signal,
					headers: {
						Accept:
							outputFormat === "html"
								? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
								: "text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.7",
					},
				});
				const contentType = response.headers.get("content-type") ?? "";
				const normalizedContentType = contentType.toLowerCase();
				if (contentType && !isTextualContentType(normalizedContentType)) {
					return `Unsupported content-type for webfetch: ${contentType.split(";")[0]}`;
				}
				const body = await readResponseBody(response, maxBytes);
				if (!contentType && looksBinaryBuffer(body.buffer)) {
					return "Unsupported content-type for webfetch: binary response";
				}
				const rawText = decodeBuffer(body.buffer, contentType);
				const isHtml = looksLikeHtml(normalizedContentType, rawText);
				let content = rawText;
				if (outputFormat === "html") {
					content = rawText;
				} else if (isHtml) {
					content =
						outputFormat === "text"
							? htmlToText(rawText)
							: htmlToMarkdown(rawText);
				} else {
					content = normalizeWhitespace(rawText);
				}

				return {
					url: input.url,
					final_url: response.url || input.url,
					status: response.status,
					ok: response.ok,
					content_type: contentType || null,
					output_format: outputFormat,
					title: isHtml ? (extractTitle(rawText) ?? null) : null,
					content,
					truncated: body.truncated,
					byte_size: body.byteSize,
				};
			} catch (error) {
				const classified = classifyFetchError(error, timeoutMs);
				return `Error fetching URL [${classified.kind}]: ${classified.detail}`;
			} finally {
				clearTimeout(timeout);
			}
		},
	});
