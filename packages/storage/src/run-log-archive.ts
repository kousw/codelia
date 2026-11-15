import type { LlmUsageRecord, SessionHeader } from "@codelia/core";
import { readRunLogRecordParts } from "./run-log-records";

export const RUN_LOG_ARCHIVE_VERSION = 1;
export const MAX_RUN_LOG_HEADER_BYTES = 256 * 1024;
const DIAGNOSTIC_RECORDS = new Set([
	"llm.request",
	"llm.response",
	"tool.output",
]);

/** Retain event bytes and independent accounting while discarding diagnostic payloads. */
export async function* projectArchivedRunLog(
	file: string,
	usage: readonly LlmUsageRecord[],
): AsyncGenerator<Buffer> {
	let headerSeen = false;
	let headerParts: Buffer[] = [];
	let headerBytes = 0;
	for await (const part of readRunLogRecordParts(file)) {
		if (!headerSeen && part.type !== "header")
			throw new Error("Run log must start with its header");
		if (part.type === "header") {
			if (headerSeen) throw new Error("Duplicate run log header");
			headerBytes += part.data.length;
			if (headerBytes > MAX_RUN_LOG_HEADER_BYTES)
				throw new Error("Run log header is too large");
			headerParts.push(part.data);
			if (part.end) {
				const header = JSON.parse(
					Buffer.concat(headerParts, headerBytes).toString("utf8"),
				) as SessionHeader;
				const { prompts: _prompts, tools: _tools, ...retained } = header;
				yield Buffer.from(
					`${JSON.stringify({
						...retained,
						meta: {
							...retained.meta,
							codelia_log_archive_version: RUN_LOG_ARCHIVE_VERSION,
						},
					})}\n`,
				);
				headerSeen = true;
				headerParts = [];
			}
		} else if (
			part.type !== "llm.usage" &&
			!DIAGNOSTIC_RECORDS.has(part.type)
		) {
			yield part.data;
		}
	}
	if (!headerSeen) throw new Error("Missing run log header");
	for (const record of usage) yield Buffer.from(`${JSON.stringify(record)}\n`);
}
