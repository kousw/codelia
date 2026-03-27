import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_CHAR_LIMIT = 10_000;
const MAX_CHAR_LIMIT = 100_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
	granularity: "grapheme",
});

const splitGraphemes = (value: string): string[] =>
	Array.from(GRAPHEME_SEGMENTER.segment(value), ({ segment }) => segment);

export const createReadLineTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "read_line",
		description:
			"Read one physical line as paged grapheme-based text by 1-based line number and 0-based char offset.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"Text file path. Sandbox-bounded unless full-access mode is active.",
				),
			line_number: z
				.number()
				.int()
				.positive()
				.describe("1-based line number to read."),
			char_offset: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("0-based grapheme offset in the target line. Default 0."),
			char_limit: z
				.number()
				.int()
				.positive()
				.max(MAX_CHAR_LIMIT)
				.optional()
				.describe(
					`Max graphemes to return. Default 10000, Max ${MAX_CHAR_LIMIT}.`,
				),
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
				const lineIndex = input.line_number - 1;
				if (lineIndex >= lines.length) {
					return `Line number out of range: ${input.line_number} (total ${lines.length})`;
				}
				const line = lines[lineIndex] ?? "";
				const chars = splitGraphemes(line);
				const charOffset = input.char_offset ?? 0;
				const charLimit = input.char_limit ?? DEFAULT_CHAR_LIMIT;

				if (charOffset > chars.length) {
					return `char_offset out of range: ${charOffset} (line length ${chars.length})`;
				}

				const segmentChars = chars.slice(charOffset, charOffset + charLimit);
				const segment = segmentChars.join("");
				const endOffset = charOffset + segmentChars.length;
				const hasMore = endOffset < chars.length;
				const header = [
					`line_number=${input.line_number}`,
					`line_length=${chars.length}`,
					`char_range=${charOffset}..${Math.max(endOffset - 1, charOffset - 1)}`,
				].join(" ");

				let output = `${header}\n${segment}`;
				if (hasMore) {
					output += `\n\nUse char_offset=${endOffset} to continue.`;
					output += `\nread_line({"file_path":${JSON.stringify(input.file_path)},"line_number":${input.line_number},"char_offset":${endOffset},"char_limit":${charLimit}})`;
				}
				return output;
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});
