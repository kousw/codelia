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
const MAX_LINE_LENGTH = 2_000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_BYTES = 50 * 1024;

const normalizeRefId = (refId: string): string =>
	refId.replace(/[^a-zA-Z0-9_-]/g, "_");

const formatLineNumber = (lineNumber: number): string =>
	String(lineNumber).padStart(5, " ");

const toLineNumbered = (lines: string[], offset: number): string =>
	lines
		.map((line, index) => `${formatLineNumber(index + offset + 1)}  ${line}`)
		.join("\n");

const splitLongLine = (line: string): string[] => {
	if (line.length <= MAX_LINE_LENGTH) {
		return [line];
	}
	const chunks: string[] = [];
	for (let start = 0; start < line.length; start += MAX_LINE_LENGTH) {
		chunks.push(line.slice(start, start + MAX_LINE_LENGTH));
	}
	return chunks;
};

const toDisplayLines = (
	physicalLines: string[],
	options: { wrapLongLines: boolean },
): { lines: string[]; wrapped: boolean; clipped: boolean } => {
	let wrapped = false;
	let clipped = false;
	const display: string[] = [];
	for (const line of physicalLines) {
		if (options.wrapLongLines) {
			const chunks = splitLongLine(line);
			if (chunks.length > 1) wrapped = true;
			display.push(...chunks);
			continue;
		}
		if (line.length > MAX_LINE_LENGTH) {
			clipped = true;
			display.push(`${line.slice(0, MAX_LINE_LENGTH)}...`);
			continue;
		}
		display.push(line);
	}
	return { lines: display, wrapped, clipped };
};

const appendReadSuffix = (
	output: string,
	options: {
		truncatedByBytes: boolean;
		hasMoreLines: boolean;
		lastReadLine: number;
		wrapped: boolean;
		clipped: boolean;
	},
): string => {
	let next = output;
	if (options.truncatedByBytes || options.hasMoreLines) {
		const reason = options.truncatedByBytes
			? `Output truncated at ${MAX_READ_BYTES} bytes.`
			: "Output has more lines.";
		next += `\n\n${reason} Use offset to read beyond line ${options.lastReadLine}.`;
	}
	if (options.wrapped) {
		next += `\n\nLong physical lines are wrapped at ${MAX_LINE_LENGTH} chars per display line. Wrapped chunks are display-only and may not match exact source text for edit.`;
	}
	if (options.clipped) {
		next += `\n\nLong physical lines are clipped at ${MAX_LINE_LENGTH} chars. Set wrap_long_lines=true to paginate full lines. Clipped output is display-only and may not match exact source text for edit.`;
	}
	return next;
};

const renderPhysicalSnippet = (
	physicalLines: string[],
	start: number,
	end: number,
): { text: string; wrapped: boolean } => {
	let wrapped = false;
	const output: string[] = [];
	for (let index = start; index < end; index += 1) {
		const chunks = splitLongLine(physicalLines[index] ?? "");
		if (chunks.length > 1) wrapped = true;
		for (const chunk of chunks) {
			output.push(`${formatLineNumber(index + 1)}  ${chunk}`);
		}
	}
	return { text: output.join("\n"), wrapped };
};

export class ToolOutputCacheStoreImpl implements ToolOutputCacheStore {
	private readonly baseDir: string;

	constructor(options: { paths?: StoragePaths } = {}) {
		const paths = options.paths ?? resolveStoragePaths();
		this.baseDir = paths.toolOutputCacheDir;
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
		const physicalLines = content.split(/\r?\n/);
		const wrapLongLines = options.wrap_long_lines ?? false;
		const display = toDisplayLines(physicalLines, { wrapLongLines });
		const offset = options.offset ?? 0;
		const limit = options.limit ?? display.lines.length;
		if (offset >= display.lines.length) {
			return "Offset exceeds output length.";
		}
		const outputLines: string[] = [];
		let bytes = 0;
		let truncatedByBytes = false;
		for (
			let index = offset;
			index < Math.min(display.lines.length, offset + limit);
			index += 1
		) {
			const line = display.lines[index] ?? "";
			const numberedLine = `${formatLineNumber(index + 1)}  ${line}`;
			const size =
				Buffer.byteLength(numberedLine, "utf8") +
				(outputLines.length > 0 ? 1 : 0);
			if (bytes + size > MAX_READ_BYTES) {
				truncatedByBytes = true;
				break;
			}
			outputLines.push(line);
			bytes += size;
		}
		const hasMoreLines = display.lines.length > offset + outputLines.length;
		const body = toLineNumbered(outputLines, offset);
		return appendReadSuffix(body, {
			truncatedByBytes,
			hasMoreLines,
			lastReadLine: offset + outputLines.length,
			wrapped: display.wrapped,
			clipped: display.clipped,
		});
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
		let hasWrappedSnippet = false;
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
			if (snippet.wrapped) hasWrappedSnippet = true;
			const rendered = `ref:${normalizeRefId(refId)}\n${snippet.text}`;
			const size =
				Buffer.byteLength(rendered, "utf8") +
				(results.length > 0 ? Buffer.byteLength("\n\n", "utf8") : 0);
			if (totalBytes + size > MAX_GREP_BYTES) {
				hasMoreMatches = true;
				break;
			}
			results.push(rendered);
			totalBytes += size;
		}

		if (!results.length) {
			if (hasMatch) {
				return `Matches found but output exceeded ${MAX_GREP_BYTES} bytes. Reduce context (before/after) and retry.`;
			}
			return `No matches for: ${options.pattern}`;
		}
		let output = results.join("\n\n");
		if (hasMoreMatches) {
			output += "\n... (truncated)";
		}
		if (hasWrappedSnippet) {
			output += `\n\nLong physical lines are wrapped at ${MAX_LINE_LENGTH} chars per display line.`;
		}
		return output;
	}

	private resolvePath(refId: string): string {
		return path.join(this.baseDir, `${normalizeRefId(refId)}.txt`);
	}
}
