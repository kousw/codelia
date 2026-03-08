import { promises as fs } from "node:fs";
import path from "node:path";
import type {
	StoragePaths,
	ToolOutputCacheReadOptions,
	ToolOutputCacheRecord,
	ToolOutputCacheSearchOptions,
	ToolOutputCacheStore,
	ToolOutputRef,
} from "@codelia/core";
import { resolveStoragePaths } from "./paths";

const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_LINE_LENGTH = 1_000;
const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const DEFAULT_MAX_GREP_BYTES = 64 * 1024;
const DEFAULT_READ_LINE_CHAR_LIMIT = 10_000;
const MAX_READ_LINE_CHAR_LIMIT = 100_000;

type ToolOutputCacheLimits = {
	maxLineLength?: number;
	maxReadBytes?: number;
	maxGrepBytes?: number;
};

const normalizeRefId = (refId: string): string =>
	refId.replace(/[^a-zA-Z0-9_-]/g, "_");

const formatLineNumber = (lineNumber: number): string =>
	String(lineNumber).padStart(5, " ");

const toLineNumbered = (lines: string[], offset: number): string =>
	lines
		.map((line, index) => `${formatLineNumber(index + offset + 1)}  ${line}`)
		.join("\n");

const normalizeLimit = (value: number | undefined, fallback: number): number => {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return Math.trunc(value);
};

const parsePositiveIntEnv = (key: string): number | undefined => {
	const raw = process.env[key];
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return parsed;
};

const clipLongLine = (line: string, maxLineLength: number): string => {
	if (line.length <= maxLineLength) return line;
	return `${line.slice(0, maxLineLength)}...`;
};

const clipUtf8ToBytes = (value: string, maxBytes: number): string => {
	if (maxBytes <= 0 || value.length === 0) return "";
	let bytes = 0;
	let out = "";
	for (const ch of value) {
		const next = Buffer.byteLength(ch, "utf8");
		if (bytes + next > maxBytes) break;
		out += ch;
		bytes += next;
	}
	return out;
};

const clipLineToByteBudget = (line: string, maxBytes: number): string => {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
	const suffix = "...";
	const suffixBytes = Buffer.byteLength(suffix, "utf8");
	if (maxBytes <= suffixBytes) {
		return clipUtf8ToBytes(line, maxBytes);
	}
	return `${clipUtf8ToBytes(line, maxBytes - suffixBytes)}${suffix}`;
};

const buildTruncatedLinesSummary = (
	lineNumbers: ReadonlyArray<number>,
): string | null => {
	if (lineNumbers.length === 0) return null;
	if (lineNumbers.length > 3) {
		return "[truncated lines: many]";
	}
	return `[truncated lines: ${lineNumbers.join(", ")}]`;
};

const appendReadSuffix = (
	output: string,
		options: {
			truncatedByBytes: boolean;
			hasMoreLines: boolean;
			lastReadLine: number;
			maxReadBytes: number;
			truncatedLineNumbers: ReadonlyArray<number>;
		},
): string => {
	let next = output;
	if (options.truncatedByBytes || options.hasMoreLines) {
		const reason = options.truncatedByBytes
			? `[output truncated at ${options.maxReadBytes} bytes]`
			: "Output has more lines.";
		next += `\n\n${reason} Use offset to read beyond line ${options.lastReadLine}.`;
	}
	const truncatedLinesSummary = buildTruncatedLinesSummary(
		Array.from(new Set(options.truncatedLineNumbers)),
	);
	if (truncatedLinesSummary) {
		next += `\n\n${truncatedLinesSummary}`;
	}
	return next;
};

const renderPhysicalSnippet = (
	physicalLines: string[],
	start: number,
	end: number,
): string => {
	const output: string[] = [];
	for (let index = start; index < end; index += 1) {
		output.push(`${formatLineNumber(index + 1)}  ${physicalLines[index] ?? ""}`);
	}
	return output.join("\n");
};

export class ToolOutputCacheStoreImpl implements ToolOutputCacheStore {
	private readonly baseDir: string;
	private readonly maxLineLength: number;
	private readonly maxReadBytes: number;
	private readonly maxGrepBytes: number;

	constructor(options: { paths?: StoragePaths; limits?: ToolOutputCacheLimits } = {}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.baseDir = paths.toolOutputCacheDir;
		this.maxLineLength = normalizeLimit(
			options.limits?.maxLineLength ??
				parsePositiveIntEnv("CODELIA_TOOL_OUTPUT_CACHE_MAX_LINE_LENGTH"),
			DEFAULT_MAX_LINE_LENGTH,
		);
		this.maxReadBytes = normalizeLimit(
			options.limits?.maxReadBytes ??
				parsePositiveIntEnv("CODELIA_TOOL_OUTPUT_CACHE_MAX_READ_BYTES"),
			DEFAULT_MAX_READ_BYTES,
		);
		this.maxGrepBytes = normalizeLimit(
			options.limits?.maxGrepBytes ??
				parsePositiveIntEnv("CODELIA_TOOL_OUTPUT_CACHE_MAX_GREP_BYTES"),
			DEFAULT_MAX_GREP_BYTES,
		);
	}

	async save(record: ToolOutputCacheRecord): Promise<ToolOutputRef> {
		const refId = normalizeRefId(record.tool_call_id);
		const filePath = this.resolvePath(refId);
		await fs.mkdir(this.baseDir, { recursive: true });
		await fs.writeFile(filePath, record.content, "utf8");
		const byteSize = Buffer.byteLength(record.content, "utf8");
		const lineCount = record.content.split(/\r?\n/).length;
		return { id: refId, byte_size: byteSize, line_count: lineCount };
	}

	async read(
		refId: string,
		options: ToolOutputCacheReadOptions = {},
	): Promise<string> {
		const filePath = this.resolvePath(refId);
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		const offset = options.offset ?? 0;
		const limit = options.limit ?? lines.length;
		if (offset >= lines.length) {
			return "Offset exceeds output length.";
		}

		const outputLines: string[] = [];
		let bytes = 0;
		let truncatedByBytes = false;
		const truncatedLineNumbers: number[] = [];
		let firstClippedLineNumber: number | null = null;
		for (
			let index = offset;
			index < Math.min(lines.length, offset + limit);
			index += 1
		) {
			const originalLine = lines[index] ?? "";
			const line = clipLongLine(originalLine, this.maxLineLength);
			if (line.length !== originalLine.length) {
				truncatedLineNumbers.push(index + 1);
				if (firstClippedLineNumber === null) {
					firstClippedLineNumber = index + 1;
				}
			}
			const numberedLine = `${formatLineNumber(index + 1)}  ${line}`;
			const size =
				Buffer.byteLength(numberedLine, "utf8") +
				(outputLines.length > 0 ? 1 : 0);
			if (bytes + size > this.maxReadBytes) {
				if (outputLines.length === 0) {
					const prefix = `${formatLineNumber(index + 1)}  `;
					const budget = this.maxReadBytes - Buffer.byteLength(prefix, "utf8");
					const clippedByBytes = clipLineToByteBudget(line, budget);
					if (clippedByBytes.length > 0) {
						outputLines.push(clippedByBytes);
						bytes = Buffer.byteLength(`${prefix}${clippedByBytes}`, "utf8");
						truncatedLineNumbers.push(index + 1);
						if (firstClippedLineNumber === null) {
							firstClippedLineNumber = index + 1;
						}
					}
				}
				truncatedByBytes = true;
				break;
			}
			outputLines.push(line);
			bytes += size;
		}
		const hasMoreLines = lines.length > offset + outputLines.length;
		const body = toLineNumbered(outputLines, offset);
		return appendReadSuffix(body, {
				truncatedByBytes,
				hasMoreLines,
				lastReadLine: offset + outputLines.length,
				maxReadBytes: this.maxReadBytes,
				truncatedLineNumbers,
			})
			.concat(
				firstClippedLineNumber !== null
					? `\n\nFor full long-line content, use tool_output_cache_line({\"ref_id\":\"${normalizeRefId(refId)}\",\"line_number\":${firstClippedLineNumber},\"char_offset\":0,\"char_limit\":10000}).`
					: "",
			);
	}

	async readTail(
		refId: string,
		options: { tail_lines: number },
	): Promise<{ content: string; total_lines: number; omitted_lines: number }> {
		const filePath = this.resolvePath(refId);
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		const tailLines = Math.max(1, Math.trunc(options.tail_lines));
		const start = Math.max(0, lines.length - tailLines);
		return {
			content: lines.slice(start).join("\n"),
			total_lines: lines.length,
			omitted_lines: start,
		};
	}

	async readLine(
		refId: string,
		options: { line_number: number; char_offset?: number; char_limit?: number },
	): Promise<string> {
		const filePath = this.resolvePath(refId);
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		const lineIndex = options.line_number - 1;
		if (lineIndex < 0 || lineIndex >= lines.length) {
			return `Line number out of range: ${options.line_number} (total ${lines.length})`;
		}
		const line = lines[lineIndex] ?? "";
		const charOffset = Math.max(0, options.char_offset ?? 0);
		const charLimit = Math.max(
			1,
			Math.min(
				Math.trunc(options.char_limit ?? DEFAULT_READ_LINE_CHAR_LIMIT),
				MAX_READ_LINE_CHAR_LIMIT,
			),
		);
		if (charOffset > line.length) {
			return `char_offset out of range: ${charOffset} (line length ${line.length})`;
		}
		const segment = line.slice(charOffset, charOffset + charLimit);
		const endOffset = charOffset + segment.length;
		const hasMore = endOffset < line.length;
		let output = [
			`ref_id=${normalizeRefId(refId)}`,
			`line_number=${options.line_number}`,
			`line_length=${line.length}`,
			`char_range=${charOffset}..${Math.max(endOffset - 1, charOffset - 1)}`,
			segment,
		].join("\n");
		if (hasMore) {
			output += `\n\nUse char_offset=${endOffset} to continue.`;
			output += `\ntool_output_cache_line({\"ref_id\":\"${normalizeRefId(refId)}\",\"line_number\":${options.line_number},\"char_offset\":${endOffset},\"char_limit\":${charLimit}})`;
		}
		return output;
	}

	async grep(
		refId: string,
		options: ToolOutputCacheSearchOptions,
	): Promise<string> {
		const filePath = this.resolvePath(refId);
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split(/\r?\n/);
		const regex = options.regex
			? new RegExp(options.pattern)
			: new RegExp(options.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
		const before = Math.max(0, options.before ?? 0);
		const after = Math.max(0, options.after ?? 0);
		const maxMatches = Math.max(1, options.max_matches ?? DEFAULT_MAX_MATCHES);
		const results: string[] = [];
		let totalBytes = 0;
		let hasMoreMatches = false;
		let hasMatch = false;

		for (let i = 0; i < lines.length; i += 1) {
			if (results.length >= maxMatches) {
				hasMoreMatches = true;
				break;
			}
			if (!regex.test(lines[i])) continue;
			hasMatch = true;
			const start = Math.max(0, i - before);
			const end = Math.min(lines.length, i + after + 1);
			const snippet = renderPhysicalSnippet(lines, start, end);
			const rendered = `ref:${normalizeRefId(refId)}\n${snippet}`;
			const size =
				Buffer.byteLength(rendered, "utf8") +
				(results.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0);
			if (totalBytes + size > this.maxGrepBytes) {
				if (results.length === 0) {
					return [
						`MATCH_TOO_LARGE_TO_RENDER: match at line ${i + 1} exceeded ${this.maxGrepBytes} bytes.`,
						`ref_id=${normalizeRefId(refId)}`,
						"Reduce grep context (before/after) or read the matched line directly:",
						`tool_output_cache_line({\"ref_id\":\"${normalizeRefId(refId)}\",\"line_number\":${i + 1},\"char_offset\":0,\"char_limit\":10000})`,
					].join("\n");
				}
				hasMoreMatches = true;
				break;
			}
			results.push(rendered);
			totalBytes += size;
		}

		if (!results.length) {
			if (hasMatch) {
				return `Matches found but output exceeded ${this.maxGrepBytes} bytes. Reduce context (before/after) and retry.`;
			}
			return `No matches for: ${options.pattern}`;
		}
		let output = results.join("\n\n");
		if (hasMoreMatches) {
			output += "\n... (truncated)";
		}
		return output;
	}

	private resolvePath(refId: string): string {
		return path.join(this.baseDir, `${normalizeRefId(refId)}.txt`);
	}
}
