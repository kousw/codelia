import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { walkFiles } from "../utils/glob";

const GREP_MAX_RESULTS = 50;
const GREP_LINE_PREVIEW_CHARS = 100;

const clipPreviewLine = (line: string): { text: string; truncated: boolean } => {
	if (line.length <= GREP_LINE_PREVIEW_CHARS) {
		return { text: line, truncated: false };
	}
	return {
		text: `${line.slice(0, GREP_LINE_PREVIEW_CHARS)}... [line truncated]`,
		truncated: true,
	};
};

const formatMatchPath = (options: {
	filePath: string;
	searchRoot: string;
	rootDir: string;
	requestedPath?: string;
	searchTargetIsFile: boolean;
}): string => {
	if (options.searchTargetIsFile) {
		return options.requestedPath?.trim() || path.relative(options.rootDir, options.filePath).replaceAll("\\", "/");
	}
	const relPath = path.relative(options.searchRoot, options.filePath).replaceAll("\\", "/");
	return relPath || path.basename(options.filePath);
};

export const createGrepTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "grep",
		description: "Search file contents with a regex pattern.",
		input: z.object({
			pattern: z.string().describe("Regex pattern (JavaScript syntax)."),
			path: z
				.string()
				.optional()
				.describe(
					"Optional file or directory path. Defaults to the current working directory.",
				),
		}),
		execute: async (input, ctx) => {
			let searchPath: string;
			let rootDir: string;
			let pathLabel: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				rootDir = sandbox.rootDir;
				searchPath = input.path ? sandbox.resolvePath(input.path) : sandbox.workingDir;
				pathLabel = input.path ?? searchPath;
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern);
			} catch (error) {
				return `Invalid regex: ${String(error)}`;
			}

			const results: string[] = [];
			let truncated = false;
			const pushResult = (value: string): boolean => {
				if (results.length >= GREP_MAX_RESULTS) {
					truncated = true;
					return false;
				}
				results.push(value);
				return true;
			};

			const searchFile = async (
				filePath: string,
				searchTargetIsFile: boolean,
			): Promise<boolean> => {
				try {
					const content = await fs.readFile(filePath, "utf8");
					const lines = content.split(/\r?\n/);
					const displayPath = formatMatchPath({
						filePath,
						searchRoot: searchPath,
						rootDir,
						requestedPath: input.path,
						searchTargetIsFile,
					});
					for (let i = 0; i < lines.length; i++) {
						regex.lastIndex = 0;
						if (!regex.test(lines[i])) continue;
						const preview = clipPreviewLine(lines[i]);
						const keepGoing = pushResult(`${displayPath}:${i + 1}: ${preview.text}`);
						if (!keepGoing) return false;
					}
				} catch {
					return true;
				}
				return true;
			};

			try {
				const stats = await fs.stat(searchPath);
				if (stats.isFile()) {
					await searchFile(searchPath, true);
				} else if (stats.isDirectory()) {
					await walkFiles(searchPath, (filePath) => searchFile(filePath, false));
				} else {
					return `Path is not a file or directory: ${pathLabel}`;
				}
			} catch (error) {
				return `Error reading path: ${pathLabel} (${String(error)})`;
			}

			if (!results.length) {
				return `No matches for: ${input.pattern}`;
			}
			return truncated
				? `${results.join("\n")}\n... (truncated, showing first ${GREP_MAX_RESULTS} matches)`
				: results.join("\n");
		},
	});
