import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_CHAR_LIMIT = 10_000;
const MAX_CHAR_LIMIT = 100_000;

export const createReadLineTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "read_line",
		description:
			"Read a single line segment by 1-based line number and 0-based char offset.",
		input: z.object({
			file_path: z
				.string()
				.describe(
					"File path. Sandbox-bounded unless full-access mode is active.",
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
				.describe("0-based start character in the target line. Default 0."),
			char_limit: z
				.number()
				.int()
				.positive()
				.max(MAX_CHAR_LIMIT)
				.optional()
				.describe("Max chars to return. Default 10000."),
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
				const charOffset = input.char_offset ?? 0;
				const charLimit = input.char_limit ?? DEFAULT_CHAR_LIMIT;

				if (charOffset > line.length) {
					return `char_offset out of range: ${charOffset} (line length ${line.length})`;
				}

				const segment = line.slice(charOffset, charOffset + charLimit);
				const endOffset = charOffset + segment.length;
				const hasMore = endOffset < line.length;
				const header = [
					`line_number=${input.line_number}`,
					`line_length=${line.length}`,
					`char_range=${charOffset}..${Math.max(endOffset - 1, charOffset - 1)}`,
				].join(" ");

				let output = `${header}\n${segment}`;
				if (hasMore) {
					output += `\n\nUse char_offset=${endOffset} to continue.`;
					output += `\nread_line({"file_path":"${input.file_path}","line_number":${input.line_number},"char_offset":${endOffset},"char_limit":${charLimit}})`;
				}
				return output;
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});
