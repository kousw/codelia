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

const normalizeRefId = (refId: string): string =>
	refId.replace(/[^a-zA-Z0-9_-]/g, "_");

const formatLineNumber = (lineNumber: number): string =>
	String(lineNumber).padStart(5, " ");

const toLineNumbered = (lines: string[], offset: number): string =>
	lines
		.map((line, index) => `${formatLineNumber(index + offset + 1)}  ${line}`)
		.join("\n");

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
		const lines = content.split(/\r?\n/);
		const offset = options.offset ?? 0;
		const limit = options.limit ?? lines.length;
		if (offset >= lines.length) {
			return "Offset exceeds output length.";
		}
		const slice = lines.slice(offset, offset + limit);
		return toLineNumbered(slice, offset);
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

		for (let i = 0; i < lines.length; i += 1) {
			if (results.length >= maxMatches) break;
			if (!regex.test(lines[i])) continue;
			const start = Math.max(0, i - before);
			const end = Math.min(lines.length, i + after + 1);
			const snippet = toLineNumbered(lines.slice(start, end), start);
			results.push(`ref:${normalizeRefId(refId)}\n${snippet}`);
		}

		if (!results.length) {
			return `No matches for: ${options.pattern}`;
		}
		return results.length >= maxMatches
			? `${results.join("\n\n")}\n... (truncated)`
			: results.join("\n\n");
	}

	private resolvePath(refId: string): string {
		return path.join(this.baseDir, `${normalizeRefId(refId)}.txt`);
	}
}
