import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { walkFiles } from "../utils/glob";

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
			let searchDir: string;
			let rootDir: string;
			let pathLabel: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				rootDir = sandbox.rootDir;
				searchDir = input.path
					? sandbox.resolvePath(input.path)
					: sandbox.workingDir;
				pathLabel = input.path ?? searchDir;
			} catch (error) {
				return `Security error: ${String(error)}`;
			}

			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern);
			} catch (error) {
				return `Invalid regex: ${String(error)}`;
			}

			const results: string[] = [];
			const searchFile = async (filePath: string): Promise<boolean> => {
				if (results.length >= 50) return false;
				try {
					const content = await fs.readFile(filePath, "utf8");
					const lines = content.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i])) {
							const relPath = path
								.relative(rootDir, filePath)
								.replaceAll("\\", "/");
							results.push(`${relPath}:${i + 1}: ${lines[i].slice(0, 100)}`);
							if (results.length >= 50) return false;
						}
					}
				} catch {
					return true;
				}
				return true;
			};

			try {
				const stats = await fs.stat(searchDir);
				if (stats.isFile()) {
					await searchFile(searchDir);
				} else if (stats.isDirectory()) {
					await walkFiles(searchDir, searchFile);
				} else {
					return `Path is not a file or directory: ${pathLabel}`;
				}
			} catch (error) {
				return `Error reading path: ${pathLabel} (${String(error)})`;
			}

			if (!results.length) {
				return `No matches for: ${input.pattern}`;
			}
			return results.length >= 50
				? `${results.join("\n")}\n... (truncated)`
				: results.join("\n");
		},
	});
