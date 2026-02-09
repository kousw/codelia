import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type DependencyKey, defineTool, type Tool } from "@codelia/core";
import { z } from "zod";
import {
	getSandboxContext,
	resolveSandboxPath,
	resolveSandboxSearch,
	type SandboxContext,
} from "./sandbox";

const MAX_TIMEOUT_S = 120;
const MAX_OUTPUT = 10 * 1024 * 1024;

const runShell = async (
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<string> => {
	const proc = Bun.spawn(["sh", "-c", command], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});

	let killed = false;
	const timer = setTimeout(() => {
		killed = true;
		proc.kill();
	}, timeoutMs);

	try {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		const output = `${stdout}${stderr}`.trim().slice(0, MAX_OUTPUT);
		if (killed) return `Command timed out after ${timeoutMs / 1000}s`;
		return output || "(no output)";
	} finally {
		clearTimeout(timer);
	}
};

// ── bash ──

const createBashTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "bash",
		description: "Execute a shell command and return output",
		input: z.object({
			command: z.string(),
			timeout: z.number().int().positive().optional(),
		}),
		execute: async (input, ctx) => {
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const timeoutSeconds = Math.min(input.timeout ?? 30, MAX_TIMEOUT_S);
			try {
				return await runShell(
					input.command,
					sandbox.workingDir,
					timeoutSeconds * 1000,
				);
			} catch (error) {
				return `Error: ${String(error instanceof Error ? error.message : error)}`;
			}
		},
	});

// ── read ──

const createReadTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "read",
		description: "Read contents of a file",
		input: z.object({ file_path: z.string() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;
			try {
				const stat = await fs.stat(resolved.resolved);
				if (stat.isDirectory())
					return `Path is a directory: ${input.file_path}`;
			} catch {
				return `File not found: ${input.file_path}`;
			}
			try {
				const content = await fs.readFile(resolved.resolved, "utf8");
				const lines = content.split(/\r?\n/);
				const numbered = lines.map(
					(line, index) => `${String(index + 1).padStart(4, " ")}  ${line}`,
				);
				return numbered.join("\n");
			} catch (error) {
				return `Error reading file: ${String(error)}`;
			}
		},
	});

// ── write ──

const createWriteTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "write",
		description: "Write content to a file",
		input: z.object({ file_path: z.string(), content: z.string() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;
			try {
				await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
				await fs.writeFile(resolved.resolved, input.content, "utf8");
				return `Wrote ${input.content.length} bytes to ${input.file_path}`;
			} catch (error) {
				return `Error writing file: ${String(error)}`;
			}
		},
	});

// ── edit ──

type EditMatch = { start: number; end: number };

const trimLine = (line: string): string => line.replace(/\r$/, "").trim();

const lineRangeToIndices = (
	lines: string[],
	startLine: number,
	lineCount: number,
): EditMatch => {
	let startIndex = 0;
	for (let i = 0; i < startLine; i++) {
		startIndex += lines[i].length + 1;
	}
	let endIndex = startIndex;
	for (let i = 0; i < lineCount; i++) {
		endIndex += lines[startLine + i].length;
		if (i < lineCount - 1) endIndex += 1;
	}
	return { start: startIndex, end: endIndex };
};

const findExactMatches = (content: string, needle: string): EditMatch[] => {
	if (!needle) return [];
	const matches: EditMatch[] = [];
	let index = 0;
	while (index <= content.length) {
		const found = content.indexOf(needle, index);
		if (found === -1) break;
		matches.push({ start: found, end: found + needle.length });
		index = found + needle.length;
	}
	return matches;
};

const findLineTrimmedMatches = (
	content: string,
	needle: string,
): EditMatch[] => {
	const contentLines = content.split("\n");
	const needleLines = needle.split("\n");
	if (needleLines.at(-1) === "") needleLines.pop();
	if (needleLines.length === 0) return [];
	const matches: EditMatch[] = [];
	for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
		let ok = true;
		for (let j = 0; j < needleLines.length; j++) {
			if (trimLine(contentLines[i + j]) !== trimLine(needleLines[j])) {
				ok = false;
				break;
			}
		}
		if (ok) {
			matches.push(lineRangeToIndices(contentLines, i, needleLines.length));
			i += needleLines.length - 1;
		}
	}
	return matches;
};

const resolveEditMatches = (
	content: string,
	needle: string,
): { matches: EditMatch[] } | null => {
	const exact = findExactMatches(content, needle);
	if (exact.length) return { matches: exact };
	const lineTrimmed = findLineTrimmedMatches(content, needle);
	if (lineTrimmed.length) return { matches: lineTrimmed };
	return null;
};

const applyReplacements = (
	content: string,
	matches: EditMatch[],
	replacement: string,
): string => {
	const sorted = [...matches].sort((a, b) => b.start - a.start);
	let next = content;
	for (const match of sorted) {
		next = `${next.slice(0, match.start)}${replacement}${next.slice(match.end)}`;
	}
	return next;
};

const normalizeLineEndings = (text: string): string =>
	text.replace(/\r\n/g, "\n");

const toLines = (text: string): string[] =>
	text === "" ? [] : text.split("\n");

const createUnifiedDiff = (
	filePath: string,
	before: string,
	after: string,
	context = 3,
): string => {
	const oldText = normalizeLineEndings(before);
	const newText = normalizeLineEndings(after);
	if (oldText === newText) return "";
	const oldLines = toLines(oldText);
	const newLines = toLines(newText);
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	)
		prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] ===
			newLines[newLines.length - 1 - suffix]
	)
		suffix++;
	const oldChangeStart = prefix;
	const oldChangeEnd = oldLines.length - suffix;
	const newChangeStart = prefix;
	const newChangeEnd = newLines.length - suffix;
	const hunkOldStart = Math.max(0, oldChangeStart - context);
	const hunkOldEnd = Math.min(oldLines.length, oldChangeEnd + context);
	const hunkNewStart = Math.max(0, newChangeStart - context);
	const hunkNewEnd = Math.min(newLines.length, newChangeEnd + context);
	const hunkOldLen = hunkOldEnd - hunkOldStart;
	const hunkNewLen = hunkNewEnd - hunkNewStart;
	const oldStartLine = hunkOldLen === 0 ? 0 : hunkOldStart + 1;
	const newStartLine = hunkNewLen === 0 ? 0 : hunkNewStart + 1;
	const header = [
		`--- ${filePath}`,
		`+++ ${filePath}`,
		`@@ -${oldStartLine},${hunkOldLen} +${newStartLine},${hunkNewLen} @@`,
	];
	const lines: string[] = [];
	for (let i = hunkOldStart; i < oldChangeStart; i++)
		lines.push(` ${oldLines[i]}`);
	for (let i = oldChangeStart; i < oldChangeEnd; i++)
		lines.push(`-${oldLines[i]}`);
	for (let i = newChangeStart; i < newChangeEnd; i++)
		lines.push(`+${newLines[i]}`);
	for (let i = oldChangeEnd; i < hunkOldEnd; i++) lines.push(` ${oldLines[i]}`);
	return `${header.join("\n")}\n${lines.join("\n")}`;
};

const hashContent = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

const createEditTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "edit",
		description: "Replace text in a file",
		input: z.object({
			file_path: z.string(),
			old_string: z.string(),
			new_string: z.string(),
			replace_all: z.boolean().optional(),
			expected_hash: z.string().optional(),
		}),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxPath(
				ctx,
				sandboxKey,
				input.file_path,
			);
			if (!resolved.ok) return resolved.error;

			if (input.old_string !== "" && input.old_string === input.new_string) {
				return {
					summary: `No changes needed in ${input.file_path}`,
					replacements: 0,
					diff: "",
					file_path: input.file_path,
				};
			}

			const replaceAll = input.replace_all ?? false;
			let content = "";
			let fileExists = false;
			try {
				const stat = await fs.stat(resolved.resolved);
				if (stat.isDirectory())
					return `Path is a directory: ${input.file_path}`;
				fileExists = true;
				content = await fs.readFile(resolved.resolved, "utf8");
			} catch {
				if (input.old_string !== "")
					return `File not found: ${input.file_path}`;
			}

			if (input.expected_hash) {
				if (!fileExists)
					return `Expected hash provided but file not found: ${input.file_path}`;
				if (hashContent(content) !== input.expected_hash)
					return `Hash mismatch for ${input.file_path}`;
			}

			let replacements = 0;
			let nextContent = content;

			if (input.old_string === "") {
				nextContent = input.new_string;
				replacements = content === nextContent ? 0 : 1;
			} else {
				const matchResult = resolveEditMatches(content, input.old_string);
				if (!matchResult || matchResult.matches.length === 0)
					return `String not found in ${input.file_path}`;
				let matches = matchResult.matches;
				if (!replaceAll && matches.length > 1)
					return `Multiple matches (${matches.length}) found in ${input.file_path}`;
				if (!replaceAll) matches = [matches[0]];
				replacements = matches.length;
				nextContent = applyReplacements(content, matches, input.new_string);
			}

			if (content === nextContent) {
				return {
					summary: `No changes needed in ${input.file_path}`,
					replacements,
					diff: "",
					file_path: input.file_path,
				};
			}

			try {
				await fs.mkdir(path.dirname(resolved.resolved), { recursive: true });
				await fs.writeFile(resolved.resolved, nextContent, "utf8");
			} catch (error) {
				return `Error editing file: ${String(error)}`;
			}

			const diff = createUnifiedDiff(input.file_path, content, nextContent);
			return {
				summary: `Replaced ${replacements} occurrence(s) in ${input.file_path}`,
				replacements,
				diff,
				file_path: input.file_path,
			};
		},
	});

// ── glob ──

const globToRegExp = (pattern: string): RegExp => {
	const normalized = pattern.replaceAll("\\", "/");
	const globDirToken = "__GLOBSTAR_DIR__";
	const globAnyToken = "__GLOBSTAR__";
	const globSingleToken = "__GLOBSTAR_SINGLE__";
	const globCharToken = "__GLOBSTAR_CHAR__";
	const withTokens = normalized
		.replace(/\*\*\//g, globDirToken)
		.replace(/\*\*/g, globAnyToken)
		.replace(/\*/g, globSingleToken)
		.replace(/\?/g, globCharToken);
	const escaped = withTokens.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(
		`^${escaped
			.replaceAll(globDirToken, "(?:.*/)?")
			.replaceAll(globAnyToken, ".*")
			.replaceAll(globSingleToken, "[^/]*")
			.replaceAll(globCharToken, "[^/]")}$`,
	);
};

const walkFiles = async (
	startDir: string,
	visitor: (filePath: string) => Promise<boolean> | boolean,
): Promise<void> => {
	const entries = await fs.readdir(startDir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(startDir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(fullPath, visitor);
		} else if (entry.isFile()) {
			const shouldContinue = await visitor(fullPath);
			if (!shouldContinue) return;
		}
	}
};

const globMatch = async (
	searchDir: string,
	rootDir: string,
	pattern: string,
): Promise<string[]> => {
	const regex = globToRegExp(pattern.replaceAll("\\", "/"));
	const matches: string[] = [];
	await walkFiles(searchDir, async (filePath) => {
		const relPath = path.relative(rootDir, filePath).replaceAll("\\", "/");
		if (regex.test(relPath)) matches.push(relPath);
		return matches.length < 50;
	});
	return matches;
};

const createGlobSearchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "glob_search",
		description: "Find files matching a glob pattern",
		input: z.object({ pattern: z.string(), path: z.string().optional() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxSearch(ctx, sandboxKey, input.path);
			if (!resolved.ok) return resolved.error;
			try {
				const stat = await fs.stat(resolved.searchDir);
				if (!stat.isDirectory())
					return `Path is not a directory: ${input.path}`;
			} catch (error) {
				return `Error: ${String(error)}`;
			}
			const matches = await globMatch(
				resolved.searchDir,
				resolved.rootDir,
				input.pattern,
			);
			if (!matches.length) return `No files match pattern: ${input.pattern}`;
			const limited = matches.slice(0, 50);
			return `Found ${limited.length} file(s):\n${limited.join("\n")}`;
		},
	});

// ── grep ──

const createGrepTool = (sandboxKey: DependencyKey<SandboxContext>): Tool =>
	defineTool({
		name: "grep",
		description: "Search file contents with regex",
		input: z.object({ pattern: z.string(), path: z.string().optional() }),
		execute: async (input, ctx) => {
			const resolved = await resolveSandboxSearch(ctx, sandboxKey, input.path);
			if (!resolved.ok) return resolved.error;
			let regex: RegExp;
			try {
				regex = new RegExp(input.pattern);
			} catch (error) {
				return `Invalid regex: ${String(error)}`;
			}
			const results: string[] = [];
			await walkFiles(resolved.searchDir, async (filePath) => {
				if (results.length >= 50) return false;
				try {
					const content = await fs.readFile(filePath, "utf8");
					const lines = content.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i])) {
							const relPath = path
								.relative(resolved.rootDir, filePath)
								.replaceAll("\\", "/");
							results.push(`${relPath}:${i + 1}: ${lines[i].slice(0, 100)}`);
							if (results.length >= 50) return false;
						}
					}
				} catch {
					return true;
				}
				return true;
			});
			if (!results.length) return `No matches for: ${input.pattern}`;
			return results.length >= 50
				? `${results.join("\n")}\n... (truncated)`
				: results.join("\n");
		},
	});

// ── export ──

export const createTools = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool[] => [
	createBashTool(sandboxKey),
	createReadTool(sandboxKey),
	createWriteTool(sandboxKey),
	createEditTool(sandboxKey),
	createGlobSearchTool(sandboxKey),
	createGrepTool(sandboxKey),
];
