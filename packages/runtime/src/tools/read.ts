import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";

const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

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
				const lines = content.split(/\r?\n/);
				if (lines.length === 0) {
					return "";
				}

				const offset = input.offset ?? 0;
				const limit = input.limit ?? DEFAULT_READ_LIMIT;
				if (offset >= lines.length) {
					return `Offset exceeds file length: ${input.file_path}`;
				}

				const raw: string[] = [];
				let bytes = 0;
				let truncatedByBytes = false;
				for (
					let index = offset;
					index < Math.min(lines.length, offset + limit);
					index += 1
				) {
					const line =
						lines[index].length > MAX_LINE_LENGTH
							? `${lines[index].slice(0, MAX_LINE_LENGTH)}...`
							: lines[index];
					const size =
						Buffer.byteLength(line, "utf8") + (raw.length > 0 ? 1 : 0);
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
				const hasMoreLines = lines.length > lastReadLine;
				const truncated = truncatedByBytes || hasMoreLines;
				let output = numbered.join("\n");

				if (truncated) {
					const reason = truncatedByBytes
						? `Output truncated at ${MAX_BYTES} bytes.`
						: "File has more lines.";
					output += `\n\n${reason} Use offset to read beyond line ${lastReadLine}.`;
				}

				return output;
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});
