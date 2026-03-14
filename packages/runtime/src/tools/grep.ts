import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { walkFiles } from "../utils/glob";
import {
	buildRipgrepBaseArgs,
	runRipgrepLines,
	type RipgrepLineRunner,
} from "../utils/ripgrep";

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 200;
const GREP_MAX_SCAN_LIMIT = 800;
const GREP_LINE_PREVIEW_CHARS = 200;

type GrepMatchRecord = {
	path: string;
	lineNumber: number;
	lineText: string;
};

type ReadUtf8File = (filePath: string, encoding: "utf8") => Promise<string>;

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
		return (
			options.requestedPath?.trim() ||
			path.relative(options.rootDir, options.filePath).replaceAll("\\", "/")
		);
	}
	const relPath = path
		.relative(options.searchRoot, options.filePath)
		.replaceAll("\\", "/");
	return relPath || path.basename(options.filePath);
};

const resolveScanLimit = (limit: number): number =>
	Math.min(Math.max(limit * 4, 200), GREP_MAX_SCAN_LIMIT);

const decodeRipgrepText = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && "text" in value) {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	if (value && typeof value === "object" && "bytes" in value) {
		const bytes = (value as { bytes?: unknown }).bytes;
		if (typeof bytes === "string") {
			return Buffer.from(bytes, "base64").toString("utf8");
		}
	}
	return "";
};

const renderMatches = (options: {
	matches: GrepMatchRecord[];
	totalMatches: number | null;
	totalFiles: number;
	limit: number;
	scanLimit: number;
}): string => {
	const lines = options.matches.map(
		(match) => `${match.path}:${match.lineNumber}: ${match.lineText}`,
	);
	if (options.totalMatches !== null && options.totalMatches <= options.limit) {
		return `Found ${options.totalMatches} matching line(s) across ${options.totalFiles} file(s):\n${lines.join("\n")}`;
	}
	if (options.totalMatches !== null) {
		return `Found ${options.totalMatches} matching line(s) across ${options.totalFiles} file(s); showing first ${options.limit}:\n${lines.join("\n")}\n... (truncated)`;
	}
	return `Found more than ${options.scanLimit} matching line(s) across at least ${options.totalFiles} file(s); showing first ${options.limit}:\n${lines.join("\n")}\n... (truncated, search stopped early)`;
};

const runRipgrepSearch = async (
	runRipgrepLinesImpl: RipgrepLineRunner,
	options: {
		searchPath: string;
		rootDir: string;
		requestedPath?: string;
		searchTargetIsFile: boolean;
		pattern: string;
		limit: number;
		scanLimit: number;
	},
): Promise<
	| {
			status: "ok";
			matches: GrepMatchRecord[];
			totalMatches: number | null;
			totalFiles: number;
		}
	| {
			status: "fallback";
		}
	| {
			status: "error";
			error: string;
		}
> => {
	const cwd = options.searchTargetIsFile
		? path.dirname(options.searchPath)
		: options.searchPath;
	const targetArg = options.searchTargetIsFile
		? path.basename(options.searchPath)
		: ".";
	const matches: GrepMatchRecord[] = [];
	const files = new Set<string>();
	let totalMatches = 0;
	const result = await runRipgrepLinesImpl(
		[
			"--json",
			"--line-number",
			"--no-messages",
			...buildRipgrepBaseArgs(),
			"--regexp",
			options.pattern,
			targetArg,
		],
		{
			cwd,
			onLine: (line) => {
				if (!line) return true;
				const parsed: unknown = JSON.parse(line);
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					(parsed as { type?: unknown }).type !== "match"
				) {
					return true;
				}
				const data = (parsed as { data?: Record<string, unknown> }).data;
				if (!data) return true;
				const rawPath = decodeRipgrepText(data.path);
				const filePath = path.resolve(cwd, rawPath || targetArg);
				const displayPath = formatMatchPath({
					filePath,
					searchRoot: options.searchTargetIsFile ? cwd : options.searchPath,
					rootDir: options.rootDir,
					requestedPath: options.requestedPath,
					searchTargetIsFile: options.searchTargetIsFile,
				});
				files.add(displayPath);
				totalMatches += 1;
				if (matches.length < options.limit) {
					const lineNumber = Number(data.line_number ?? 0);
					const rawLine = decodeRipgrepText(data.lines).replace(/\r?\n$/, "");
					matches.push({
						path: displayPath,
						lineNumber,
						lineText: clipPreviewLine(rawLine).text,
					});
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
	if (result.terminatedEarly) {
		return {
			status: "ok",
			matches,
			totalMatches: null,
			totalFiles: files.size,
		};
	}
	if (result.exitCode === 1) {
		return {
			status: "ok",
			matches: [],
			totalMatches: 0,
			totalFiles: 0,
		};
	}
	if (result.exitCode !== 0) {
		const stderr = result.stderr.trim();
		if (result.exitCode === 2 && !stderr) {
			return {
				status: "ok",
				matches,
				totalMatches,
				totalFiles: files.size,
			};
		}
		return {
			status: "error",
			error: stderr || `ripgrep failed (exit code ${String(result.exitCode)})`,
		};
	}
	return {
		status: "ok",
		matches,
		totalMatches,
		totalFiles: files.size,
	};
};

const runFallbackSearch = async (options: {
	searchPath: string;
	rootDir: string;
	requestedPath?: string;
	searchTargetIsFile: boolean;
	pattern: string;
	limit: number;
	scanLimit: number;
	readFile?: ReadUtf8File;
}): Promise<
	| {
			status: "ok";
			matches: GrepMatchRecord[];
			totalMatches: number | null;
			totalFiles: number;
		}
	| {
			status: "error";
			error: string;
		}
> => {
	let regex: RegExp;
	try {
		regex = new RegExp(options.pattern);
	} catch (error) {
		return {
			status: "error",
			error: `Invalid regex: ${String(error)}`,
		};
	}
	const matches: GrepMatchRecord[] = [];
	const files = new Set<string>();
	const searchRoot = options.searchTargetIsFile
		? path.dirname(options.searchPath)
		: options.searchPath;
	const readFile = options.readFile ?? fs.readFile;
	let totalMatches = 0;
	let readError: string | null = null;
	const searchFile = async (filePath: string): Promise<boolean> => {
		const displayPath = formatMatchPath({
			filePath,
			searchRoot,
			rootDir: options.rootDir,
			requestedPath: options.requestedPath,
			searchTargetIsFile: options.searchTargetIsFile,
		});
		let content: string;
		try {
			content = await readFile(filePath, "utf8");
		} catch (error) {
			if (options.searchTargetIsFile) {
				readError = `Error reading file: ${displayPath} (${String(error)})`;
				return false;
			}
			return true;
		}
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			regex.lastIndex = 0;
			if (!regex.test(lines[i])) continue;
			files.add(displayPath);
			totalMatches += 1;
			if (matches.length < options.limit) {
				matches.push({
					path: displayPath,
					lineNumber: i + 1,
					lineText: clipPreviewLine(lines[i]).text,
				});
			}
			if (totalMatches > options.scanLimit) {
				return false;
			}
		}
		return true;
	};
	try {
		if (options.searchTargetIsFile) {
			await searchFile(options.searchPath);
		} else {
			await walkFiles(options.searchPath, searchFile);
		}
	} catch (error) {
		return {
			status: "error",
			error: `Error reading path: ${options.requestedPath ?? options.searchPath} (${String(error)})`,
		};
	}
	if (readError) {
		return {
			status: "error",
			error: readError,
		};
	}
	return {
		status: "ok",
		matches,
		totalMatches: totalMatches > options.scanLimit ? null : totalMatches,
		totalFiles: files.size,
	};
};

export const createGrepTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	options: {
		runRipgrepLines?: RipgrepLineRunner;
		readFile?: ReadUtf8File;
	} = {},
): Tool =>
	defineTool({
		name: "grep",
		description: "Quick bounded regex search; use shell+rg for complex queries.",
		input: z.object({
			pattern: z
				.string()
				.describe("Regex pattern (ripgrep/default engine syntax)."),
			path: z
				.string()
				.optional()
				.describe(
					"Optional file or directory path. Defaults to the current working directory.",
				),
			limit: z
				.number()
				.int()
				.positive()
				.max(GREP_MAX_LIMIT)
				.optional()
				.describe(`Max matching lines to show. Default ${GREP_DEFAULT_LIMIT}. Max ${GREP_MAX_LIMIT}.`),
		}),
		execute: async (input, ctx) => {
			let searchPath: string;
			let rootDir: string;
			let pathLabel: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				rootDir = sandbox.rootDir;
				searchPath = input.path
					? sandbox.resolvePath(input.path)
					: sandbox.workingDir;
				pathLabel = input.path ?? searchPath;
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			let searchTargetIsFile = false;
			try {
				const stats = await fs.stat(searchPath);
				if (stats.isFile()) {
					searchTargetIsFile = true;
				} else if (!stats.isDirectory()) {
					return `Path is not a file or directory: ${pathLabel}`;
				}
			} catch (error) {
				return `Error reading path: ${pathLabel} (${String(error)})`;
			}

			const limit = input.limit ?? GREP_DEFAULT_LIMIT;
			const scanLimit = resolveScanLimit(limit);
			const ripgrepResult = await runRipgrepSearch(
				options.runRipgrepLines ?? runRipgrepLines,
				{
					searchPath,
					rootDir,
					requestedPath: input.path,
					searchTargetIsFile,
					pattern: input.pattern,
					limit,
					scanLimit,
				},
			);
			const result =
				ripgrepResult.status === "ok"
					? ripgrepResult
					: ripgrepResult.status === "fallback"
						? await runFallbackSearch({
							searchPath,
							rootDir,
							requestedPath: input.path,
							searchTargetIsFile,
							pattern: input.pattern,
							limit,
							scanLimit,
							readFile: options.readFile,
						})
						: ripgrepResult;
			if (result.status === "error") {
				return result.error;
			}
			if (!result.matches.length) {
				return `No matches for: ${input.pattern}`;
			}
			return renderMatches({
				matches: result.matches,
				totalMatches: result.totalMatches,
				totalFiles: result.totalFiles,
				limit,
				scanLimit,
			});
		},
	});
