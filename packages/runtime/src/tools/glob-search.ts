import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { globMatch } from "../utils/glob";

export const createGlobSearchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "glob_search",
		description: "Find files by glob pattern under a directory.",
		input: z.object({
			pattern: z.string().describe("Glob pattern (for example: **/*.ts)."),
			path: z
				.string()
				.optional()
				.describe(
					"Optional directory path. Defaults to the current working directory.",
				),
		}),
		execute: async (input, ctx) => {
			let searchDir: string;
			let rootDir: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				rootDir = sandbox.rootDir;
				searchDir = input.path
					? sandbox.resolvePath(input.path)
					: sandbox.workingDir;
			} catch (error) {
				return `Security error: ${String(error)}`;
			}

			try {
				const stat = await fs.stat(searchDir);
				if (!stat.isDirectory()) {
					return `Path is not a directory: ${input.path}`;
				}
			} catch (error) {
				return `Error: ${String(error)}`;
			}

			const matches = await globMatch(searchDir, rootDir, input.pattern);
			if (!matches.length) {
				return `No files match pattern: ${input.pattern}`;
			}
			const limited = matches.slice(0, 50);
			return `Found ${limited.length} file(s):\n${limited.join("\n")}`;
		},
	});
