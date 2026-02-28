import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff } from "../utils/diff";

const buildDiffPreview = (content: string, filePath: string): string => {
	const diff = createUnifiedDiff(filePath, "", content);
	if (!diff) {
		return `--- ${filePath}\n+++ ${filePath}\n@@ -0,0 +0,0 @@`;
	}
	return diff;
};

export const createWriteTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "write",
		description: "Write text to a file, creating parent directories if needed.",
		input: z.object({
			file_path: z.string().describe("File path under the sandbox root."),
			content: z.string().describe("UTF-8 text content to write."),
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
				await fs.mkdir(path.dirname(resolved), { recursive: true });
				await fs.writeFile(resolved, input.content, "utf8");
				const diff = buildDiffPreview(input.content, input.file_path);
				return {
					summary: `Wrote ${input.content.length} bytes to ${input.file_path}`,
					diff,
					file_path: input.file_path,
				};
			} catch (error) {
				return `Error writing file: ${String(error)}`;
			}
		},
	});
