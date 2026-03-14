import { promises as fs } from "node:fs";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { globMatch } from "../utils/glob";
import {
	buildRipgrepBaseArgs,
	runRipgrepLines,
	type RipgrepLineRunner,
} from "../utils/ripgrep";

const GLOB_DEFAULT_LIMIT = 100;
const GLOB_MAX_LIMIT = 200;
const GLOB_MAX_SCAN_LIMIT = 800;

const normalizeMatchPath = (value: string): string =>
	value.replace(/^\.\//, "").replaceAll("\\", "/");

const resolveScanLimit = (limit: number): number =>
	Math.min(Math.max(limit * 4, 200), GLOB_MAX_SCAN_LIMIT);

const renderGlobMatches = (options: {
	matches: string[];
	totalMatches: number | null;
	limit: number;
	scanLimit: number;
}): string => {
	if (options.totalMatches !== null && options.totalMatches <= options.limit) {
		return `Found ${options.totalMatches} file(s):\n${options.matches.join("\n")}`;
	}
	if (options.totalMatches !== null) {
		return `Found ${options.totalMatches} file(s); showing first ${options.limit}:\n${options.matches.join("\n")}\n... (truncated)`;
	}
	return `Found more than ${options.scanLimit} matching file(s); showing first ${options.limit}:\n${options.matches.join("\n")}\n... (truncated, search stopped early)`;
};

const runRipgrepGlobSearch = async (
	runRipgrepLinesImpl: RipgrepLineRunner,
	options: {
		searchDir: string;
		pattern: string;
		limit: number;
		scanLimit: number;
	},
): Promise<
	| {
			status: "ok";
			matches: string[];
			totalMatches: number | null;
		}
	| {
			status: "fallback";
		}
	| {
			status: "error";
			error: string;
		}
> => {
	const scannedMatches: string[] = [];
	let totalMatches = 0;
	const result = await runRipgrepLinesImpl(
		[
			"--files",
			"--sort",
			"path",
			...buildRipgrepBaseArgs(),
			"--glob",
			options.pattern,
		],
		{
			cwd: options.searchDir,
			onLine: (line) => {
				const normalized = normalizeMatchPath(line);
				if (!normalized) return true;
				totalMatches += 1;
				if (scannedMatches.length < options.scanLimit) {
					scannedMatches.push(normalized);
				}
				return totalMatches <= options.scanLimit;
			},
		},
	);
	if (result.status === "missing") {
		return { status: "fallback" };
	}
	if (result.status === "error") {
		return {
			status: "error",
			error: result.error,
		};
	}
	scannedMatches.sort((a, b) => a.localeCompare(b));
	const visibleMatches = scannedMatches.slice(0, options.limit);
	if (result.terminatedEarly) {
		return {
			status: "ok",
			matches: visibleMatches,
			totalMatches: null,
		};
	}
	if (result.exitCode === 1) {
		return {
			status: "ok",
			matches: [],
			totalMatches: 0,
		};
	}
	if (result.exitCode !== 0) {
		return {
			status: "error",
			error: result.stderr.trim() || `ripgrep failed (exit code ${String(result.exitCode)})`,
		};
	}
	return {
		status: "ok",
		matches: visibleMatches,
		totalMatches,
	};
};

export const createGlobSearchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	options: {
		runRipgrepLines?: RipgrepLineRunner;
	} = {},
): Tool =>
	defineTool({
		name: "glob_search",
		description: "Quick bounded glob search; use shell+rg for complex queries.",
		input: z.object({
			pattern: z.string().describe("Glob pattern (for example: **/*.ts)."),
			path: z
				.string()
				.optional()
				.describe(
					"Optional directory path. Defaults to the current working directory.",
				),
			limit: z
				.number()
				.int()
				.positive()
				.max(GLOB_MAX_LIMIT)
				.optional()
				.describe(`Max files to show. Default ${GLOB_DEFAULT_LIMIT}. Max ${GLOB_MAX_LIMIT}.`),
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

			const limit = input.limit ?? GLOB_DEFAULT_LIMIT;
			const scanLimit = resolveScanLimit(limit);
			const ripgrepResult = await runRipgrepGlobSearch(
				options.runRipgrepLines ?? runRipgrepLines,
				{
				searchDir,
				pattern: input.pattern,
				limit,
				scanLimit,
				},
			);
			if (ripgrepResult.status === "error") {
				return `Error searching files: ${ripgrepResult.error}`;
			}
			const result =
				ripgrepResult.status === "ok"
					? {
						matches: ripgrepResult.matches,
						total_matches: ripgrepResult.totalMatches,
					}
					: await globMatch(searchDir, input.pattern, scanLimit, limit);
			if (!result.matches.length) {
				return `No files match pattern: ${input.pattern}`;
			}
			return renderGlobMatches({
				matches: result.matches,
				totalMatches: result.total_matches,
				limit,
				scanLimit,
			});
		},
	});
