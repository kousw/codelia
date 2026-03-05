import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

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
	wrapLongLines: boolean,
): { lines: string[]; wrapped: boolean; clipped: boolean } => {
	let wrapped = false;
	let clipped = false;
	const display: string[] = [];
	for (const line of physicalLines) {
		if (wrapLongLines) {
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

export const createReadTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "read",
		description:
			"Read a text file with optional 0-based line offset and line limit.",
		input: z.object({
			file_path: z.string().describe("File path under the sandbox root."),
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
				.describe("Max lines to read. Default 2000."),
			wrap_long_lines: z
				.boolean()
				.optional()
				.describe("Enable to paginate very long single-line output. Default false."),
		}),
		execute: async (input, ctx) => {
			let resolved: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				return `Security error: ${String(error)}`;
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
				const physicalLines = content.split(/\r?\n/);
				if (physicalLines.length === 0) {
					return "";
				}

				const wrapLongLines = input.wrap_long_lines ?? false;
				const display = toDisplayLines(physicalLines, wrapLongLines);
				const offset = input.offset ?? 0;
				const limit = input.limit ?? DEFAULT_READ_LIMIT;
				if (offset >= display.lines.length) {
					return `Offset exceeds output length: ${input.file_path}`;
				}

				const raw: string[] = [];
				let bytes = 0;
				let truncatedByBytes = false;
				for (
					let index = offset;
					index < Math.min(display.lines.length, offset + limit);
					index += 1
				) {
					const line = display.lines[index] ?? "";
					const numberedLine = `${String(index + 1).padStart(5, " ")}  ${line}`;
					const size =
						Buffer.byteLength(numberedLine, "utf8") +
						(raw.length > 0 ? 1 : 0);
					if (bytes + size > MAX_BYTES) {
						truncatedByBytes = true;
						break;
					}
					raw.push(line);
					bytes += size;
				}

				const numbered = raw.map(
					(line, index) =>
						`${String(index + offset + 1).padStart(5, " ")}  ${line}`,
				);

				const lastReadLine = offset + raw.length;
				const hasMoreLines = display.lines.length > lastReadLine;
				const truncated = truncatedByBytes || hasMoreLines;
				let output = numbered.join("\n");

				if (truncated) {
					const reason = truncatedByBytes
						? `Output truncated at ${MAX_BYTES} bytes.`
						: "Output has more lines.";
					output += `\n\n${reason} Use offset to read beyond line ${lastReadLine}.`;
				}
				if (display.wrapped) {
					output += `\n\nLong physical lines are wrapped at ${MAX_LINE_LENGTH} chars per display line. Wrapped chunks are display-only and may not match exact source text for edit.`;
				}
				if (display.clipped) {
					output += `\n\nLong physical lines are clipped at ${MAX_LINE_LENGTH} chars. Set wrap_long_lines=true to paginate full lines. Clipped output is display-only and may not match exact source text for edit.`;
				}

				return output;
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});
