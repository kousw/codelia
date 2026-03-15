import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_MAX_LINE_LENGTH = 1_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

const parsePositiveIntEnv = (key: string, fallback: number): number => {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
};

const MAX_LINE_LENGTH = parsePositiveIntEnv(
	"CODELIA_READ_MAX_LINE_LENGTH",
	DEFAULT_MAX_LINE_LENGTH,
);
const MAX_BYTES = parsePositiveIntEnv(
	"CODELIA_READ_MAX_BYTES",
	DEFAULT_MAX_BYTES,
);

const clipLongLine = (line: string): string => {
	if (line.length <= MAX_LINE_LENGTH) {
		return line;
	}
	return `${line.slice(0, MAX_LINE_LENGTH)}...`;
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

export const createReadTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "read",
		description:
			"Read a bounded text-file preview by 0-based line offset/limit; large output is truncated and long lines should fall back to read_line.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"Text file path. Sandbox-bounded unless full-access mode is active.",
				),
			offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("0-based start line. Default 0."),
			limit: z
				.number()
				.int()
				.positive()
				.optional()
				.describe("Max preview lines to read. Default 2000."),
		}),
		execute: async (input, ctx) => {
			let resolved: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			try {
				const stat = await fs.stat(resolved);
				if (stat.isDirectory()) {
					return `Path is a directory: ${input.file_path}`;
				}
			} catch {
				return `File not found: ${input.file_path}`;
			}

			try {
				const content = await fs.readFile(resolved, "utf8");
				const lines = content.split(/\r?\n/);
				if (lines.length === 0) {
					return "";
				}

				const offset = input.offset ?? 0;
				const limit = input.limit ?? DEFAULT_READ_LIMIT;
				if (offset >= lines.length) {
					return `Offset exceeds output length: ${input.file_path}`;
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
					const line = clipLongLine(originalLine);
					if (line.length !== originalLine.length) {
						truncatedLineNumbers.push(index + 1);
						if (firstClippedLineNumber === null) {
							firstClippedLineNumber = index + 1;
						}
					}
					const numberedLine = `${String(index + 1).padStart(5, " ")}  ${line}`;
					const size =
						Buffer.byteLength(numberedLine, "utf8") +
						(outputLines.length > 0 ? 1 : 0);
					if (bytes + size > MAX_BYTES) {
						if (outputLines.length === 0) {
							const prefix = `${String(index + 1).padStart(5, " ")}  `;
							const budget = MAX_BYTES - Buffer.byteLength(prefix, "utf8");
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

				const numbered = outputLines.map(
					(line, index) =>
						`${String(index + offset + 1).padStart(5, " ")}  ${line}`,
				);
				const lastReadLine = offset + outputLines.length;
				const hasMoreLines = lines.length > lastReadLine;
				let output = numbered.join("\n");

				if (truncatedByBytes || hasMoreLines) {
					const reason = truncatedByBytes
						? `[output truncated at ${MAX_BYTES} bytes]`
						: "Output has more lines.";
					output += `\n\n${reason} Use offset to read beyond line ${lastReadLine}.`;
				}
				const truncatedLinesSummary = buildTruncatedLinesSummary(
					Array.from(new Set(truncatedLineNumbers)),
				);
				if (truncatedLinesSummary) {
					output += `\n\n${truncatedLinesSummary}`;
				}
				if (firstClippedLineNumber !== null) {
					output += `\n\nFor full long-line content, use read_line({"file_path":${JSON.stringify(input.file_path)},"line_number":${firstClippedLineNumber},"char_offset":0,"char_limit":10000}).`;
				}

				return output;
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});
