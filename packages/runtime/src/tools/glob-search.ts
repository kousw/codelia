import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { globMatch } from "../utils/glob";

const GLOB_DISPLAY_LIMIT = 50;
const GLOB_SCAN_LIMIT = 200;

const renderGlobMatches = (matches: string[], totalMatches: number | null): string => {
	const visibleMatches = matches.slice(0, GLOB_DISPLAY_LIMIT);
	if (totalMatches !== null && totalMatches <= GLOB_DISPLAY_LIMIT) {
		return `Found ${totalMatches} file(s):\n${visibleMatches.join("\n")}`;
	}
	if (totalMatches !== null) {
		return `Found ${totalMatches} file(s); showing first ${GLOB_DISPLAY_LIMIT}:\n${visibleMatches.join("\n")}\n... (truncated)`;
	}
	return `Found more than ${GLOB_SCAN_LIMIT} matching file(s); showing first ${GLOB_DISPLAY_LIMIT}:\n${visibleMatches.join("\n")}\n... (truncated, search stopped early)`;
};

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
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				searchDir = input.path
					? sandbox.resolvePath(input.path)
					: sandbox.workingDir;
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			try {
				const stat = await fs.stat(searchDir);
				if (!stat.isDirectory()) {
					return `Path is not a directory: ${input.path}`;
				}
			} catch (error) {
				return `Error: ${String(error)}`;
			}

			const result = await globMatch(searchDir, input.pattern, GLOB_SCAN_LIMIT);
			if (!result.matches.length) {
				return `No files match pattern: ${input.pattern}`;
			}
			return renderGlobMatches(result.matches, result.total_matches);
		},
	});
