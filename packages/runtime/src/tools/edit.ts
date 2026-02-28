import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff } from "../utils/diff";

type EditMatchMode = "exact" | "line_trimmed" | "block_anchor" | "auto";
type ResolvedEditMatchMode = Exclude<EditMatchMode, "auto">;
type EditMatch = { start: number; end: number };
type EditMatchResult = { mode: ResolvedEditMatchMode; matches: EditMatch[] };

const trimLine = (line: string): string => line.replace(/\r$/, "").trim();

const lineRangeToIndices = (
	lines: string[],
	startLine: number,
	lineCount: number,
): { start: number; end: number } => {
	let startIndex = 0;
	for (let i = 0; i < startLine; i++) {
		startIndex += lines[i].length + 1;
	}
	let endIndex = startIndex;
	for (let i = 0; i < lineCount; i++) {
		endIndex += lines[startLine + i].length;
		if (i < lineCount - 1) {
			endIndex += 1;
		}
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

const findBlockAnchorMatches = (
	content: string,
	needle: string,
): EditMatch[] => {
	const contentLines = content.split("\n");
	const needleLines = needle.split("\n");
	if (needleLines.at(-1) === "") needleLines.pop();
	if (needleLines.length < 3) return [];

	const first = trimLine(needleLines[0]);
	const last = trimLine(needleLines[needleLines.length - 1]);
	const candidates: Array<{ startLine: number; score: number }> = [];

	for (let i = 0; i <= contentLines.length - needleLines.length; i++) {
		if (trimLine(contentLines[i]) !== first) continue;
		const endLine = i + needleLines.length - 1;
		if (trimLine(contentLines[endLine]) !== last) continue;

		let matches = 0;
		for (let j = 0; j < needleLines.length; j++) {
			if (trimLine(contentLines[i + j]) === trimLine(needleLines[j])) {
				matches++;
			}
		}
		candidates.push({ startLine: i, score: matches / needleLines.length });
	}

	if (candidates.length === 0) return [];
	const bestScore = Math.max(...candidates.map((c) => c.score));
	return candidates
		.filter((c) => c.score === bestScore)
		.map((c) =>
			lineRangeToIndices(contentLines, c.startLine, needleLines.length),
		);
};

const resolveEditMatches = (
	content: string,
	needle: string,
	mode: EditMatchMode,
): EditMatchResult | null => {
	const exact = () => ({
		mode: "exact" as const,
		matches: findExactMatches(content, needle),
	});
	const lineTrimmed = () => ({
		mode: "line_trimmed" as const,
		matches: findLineTrimmedMatches(content, needle),
	});
	const blockAnchor = () => ({
		mode: "block_anchor" as const,
		matches: findBlockAnchorMatches(content, needle),
	});

	if (mode === "exact") return exact();
	if (mode === "line_trimmed") return lineTrimmed();
	if (mode === "block_anchor") return blockAnchor();

	const exactResult = exact();
	if (exactResult.matches.length) return exactResult;
	const lineResult = lineTrimmed();
	if (lineResult.matches.length) return lineResult;
	const blockResult = blockAnchor();
	if (blockResult.matches.length) return blockResult;
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

const hashContent = (content: string): string =>
	crypto.createHash("sha256").update(content).digest("hex");

export const createEditTool = (
	sandboxKey: DependencyKey<SandboxContext>,
): Tool =>
	defineTool({
		name: "edit",
		description: "Edit a file by replacing old_string with new_string.",
		input: z.object({
			file_path: z.string().describe("File path under the sandbox root."),
			old_string: z
				.string()
				.describe(
					"Text to find. Use empty string to replace the whole file content.",
				),
			new_string: z.string().describe("Replacement text."),
			replace_all: z
				.boolean()
				.optional()
				.describe("Replace all matches when true. Default false."),
			match_mode: z
				.enum(["exact", "line_trimmed", "block_anchor", "auto"])
				.optional()
				.describe(
					"Match strategy: exact, line_trimmed, block_anchor, or auto. Default auto.",
				),
			expected_replacements: z
				.number()
				.int()
				.nonnegative()
				.optional()
				.describe("Expected replacement count (guard)."),
			dry_run: z
				.boolean()
				.optional()
				.describe("Preview diff only when true. Default false."),
			expected_hash: z
				.string()
				.optional()
				.describe("Optional SHA-256 hash guard for current file content."),
		}),
		execute: async (input, ctx) => {
			let resolved: string;
			try {
				const sandbox = await getSandboxContext(ctx, sandboxKey);
				resolved = sandbox.resolvePath(input.file_path);
			} catch (error) {
				throw new Error(`Security error: ${String(error)}`);
			}

			if (input.old_string !== "" && input.old_string === input.new_string) {
				return {
					summary: `No changes needed in ${input.file_path} (old_string equals new_string)`,
					replacements: 0,
					match_mode: "exact" as const,
					diff: "",
					file_path: input.file_path,
				};
			}

			const replaceAll = input.replace_all ?? false;
			const matchMode = input.match_mode ?? "auto";
			const dryRun = input.dry_run ?? false;

			let content = "";
			let fileExists = false;
			try {
				const stat = await fs.stat(resolved);
				if (stat.isDirectory()) {
					throw new Error(`Path is a directory: ${input.file_path}`);
				}
				fileExists = true;
				content = await fs.readFile(resolved, "utf8");
			} catch (_error) {
				if (input.old_string !== "") {
					throw new Error(`File not found: ${input.file_path}`);
				}
			}

			if (input.expected_hash) {
				if (!fileExists) {
					throw new Error(
						`Expected hash provided but file not found: ${input.file_path}`,
					);
				}
				const currentHash = hashContent(content);
				if (currentHash !== input.expected_hash) {
					throw new Error(`Hash mismatch for ${input.file_path}`);
				}
			}

			let replacements = 0;
			let modeUsed: ResolvedEditMatchMode = "exact";
			let nextContent = content;

			if (input.old_string === "") {
				nextContent = input.new_string;
				replacements = content === nextContent ? 0 : 1;
			} else {
				const matchResult = resolveEditMatches(
					content,
					input.old_string,
					matchMode,
				);
				if (!matchResult || matchResult.matches.length === 0) {
					throw new Error(`String not found in ${input.file_path}`);
				}
				modeUsed = matchResult.mode;
				let matches = matchResult.matches;
				if (!replaceAll && matches.length > 1) {
					throw new Error(
						`Multiple matches (${matches.length}) found in ${input.file_path}`,
					);
				}
				if (!replaceAll) {
					matches = [matches[0]];
				}
				replacements = matches.length;
				nextContent = applyReplacements(content, matches, input.new_string);
			}

			if (
				input.expected_replacements !== undefined &&
				replacements !== input.expected_replacements
			) {
				throw new Error(
					`Expected ${input.expected_replacements} replacements, found ${replacements}`,
				);
			}

			const diff = createUnifiedDiff(input.file_path, content, nextContent);

			if (dryRun) {
				return {
					summary: `Preview: ${replacements} replacement(s) in ${input.file_path}`,
					replacements,
					match_mode: modeUsed,
					diff,
					file_path: input.file_path,
				};
			}

			if (content === nextContent) {
				return {
					summary: `No changes needed in ${input.file_path}`,
					replacements,
					match_mode: modeUsed,
					diff,
					file_path: input.file_path,
				};
			}

			try {
				await fs.mkdir(path.dirname(resolved), { recursive: true });
				await fs.writeFile(resolved, nextContent, "utf8");
			} catch (error) {
				throw new Error(`Error editing file: ${String(error)}`);
			}

			return {
				summary: `Replaced ${replacements} occurrence(s) in ${input.file_path}`,
				replacements,
				match_mode: modeUsed,
				diff,
				file_path: input.file_path,
			};
		},
	});
