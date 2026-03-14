import { promises as fs } from "node:fs";
import path from "node:path";
import type { DependencyKey, Tool, ToolOutputCacheStore } from "@codelia/core";
import { defineTool } from "@codelia/core";
import { z } from "zod";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff } from "../utils/diff";
import { buildDiffPayload } from "./diff-payload";

type ParsedPatch =
	| { type: "add"; filePath: string; lines: string[] }
	| { type: "delete"; filePath: string }
	| {
			type: "update";
			filePath: string;
			moveTo?: string;
			chunks: PatchChunk[];
	  };

type PatchChunk = {
	changeContext?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile?: boolean;
};

type PreparedPatchChange = {
	kind: "add" | "delete" | "update" | "move";
	filePath: string;
	resolvedPath: string;
	moveTo?: string;
	resolvedMoveTo?: string;
	sourceMode?: number;
	before: string;
	after: string;
	diff: string;
};

type LineReplacement = {
	startIndex: number;
	deleteCount: number;
	insertLines: string[];
};

type PatchFileSummary = {
	action: "add" | "delete" | "update" | "move";
	file_path: string;
	move_to?: string;
	summary: string;
};

const BEGIN_MARKER = "*** Begin Patch";
const END_MARKER = "*** End Patch";
const END_OF_FILE_MARKER = "*** End of File";

const normalizePatchText = (value: string): string =>
	value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const isFileHeader = (line: string): boolean =>
	line.startsWith("*** Add File: ") ||
	line.startsWith("*** Delete File: ") ||
	line.startsWith("*** Update File: ");

const requirePatchPath = (kind: string, value: string): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error(`Patch parse failed: missing path in ${kind}`);
	}
	return trimmed;
};

const parsePatchHeader = (
	line: string,
): { kind: "add" | "delete" | "update"; filePath: string } | null => {
	if (line.startsWith("*** Add File: ")) {
		return {
			kind: "add",
			filePath: requirePatchPath(
				"Add File",
				line.slice("*** Add File: ".length),
			),
		};
	}
	if (line.startsWith("*** Delete File: ")) {
		return {
			kind: "delete",
			filePath: requirePatchPath(
				"Delete File",
				line.slice("*** Delete File: ".length),
			),
		};
	}
	if (line.startsWith("*** Update File: ")) {
		return {
			kind: "update",
			filePath: requirePatchPath(
				"Update File",
				line.slice("*** Update File: ".length),
			),
		};
	}
	return null;
};

const parseAddFileLines = (
	lines: string[],
	startIndex: number,
	endIndex: number,
): { lines: string[]; nextIndex: number } => {
	const output: string[] = [];
	let index = startIndex;
	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (isFileHeader(line) || line === END_MARKER) {
			break;
		}
		if (!line.startsWith("+")) {
			throw new Error(
				`Patch parse failed: add file lines must start with '+' (line ${index + 1})`,
			);
		}
		output.push(line.slice(1));
		index += 1;
	}
	return { lines: output, nextIndex: index };
};

const parseUpdateChunks = (
	lines: string[],
	startIndex: number,
	endIndex: number,
	options: { allowEmpty?: boolean } = {},
): { chunks: PatchChunk[]; nextIndex: number } => {
	const chunks: PatchChunk[] = [];
	let sectionHasModification = false;
	let index = startIndex;

	while (index < endIndex) {
		const line = lines[index] ?? "";
		if (isFileHeader(line) || line === END_MARKER) {
			break;
		}
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		if (!line.startsWith("@@")) {
			throw new Error(
				`Patch parse failed: expected '@@' chunk header (line ${index + 1})`,
			);
		}

		const changeContext = line.slice(2).trimStart() || undefined;
		index += 1;

		const oldLines: string[] = [];
		const newLines: string[] = [];
		let hasModification = false;
		let isEndOfFile = false;

		while (index < endIndex) {
			const bodyLine = lines[index] ?? "";
			if (
				bodyLine.startsWith("@@") ||
				isFileHeader(bodyLine) ||
				bodyLine === END_MARKER
			) {
				break;
			}
			if (bodyLine === END_OF_FILE_MARKER) {
				isEndOfFile = true;
				index += 1;
				break;
			}
			const marker = bodyLine[0];
			const content = bodyLine.slice(1);
			switch (marker) {
				case " ":
					oldLines.push(content);
					newLines.push(content);
					break;
				case "-":
					oldLines.push(content);
					hasModification = true;
					break;
				case "+":
					newLines.push(content);
					hasModification = true;
					break;
				default:
					throw new Error(
						`Patch parse failed: invalid change marker '${marker}' (line ${index + 1})`,
					);
			}
			index += 1;
		}

		sectionHasModification ||= hasModification;

		chunks.push({
			...(changeContext ? { changeContext } : {}),
			oldLines,
			newLines,
			...(isEndOfFile ? { isEndOfFile: true } : {}),
		});
	}

	if (chunks.length === 0 && !options.allowEmpty) {
		throw new Error("Patch parse failed: update file section has no chunks");
	}
	if (!sectionHasModification && !options.allowEmpty) {
		throw new Error(
			"Patch parse failed: update file section must contain at least one '+' or '-' change",
		);
	}
	return { chunks, nextIndex: index };
};

const parsePatch = (patchText: string): ParsedPatch[] => {
	const normalized = normalizePatchText(patchText);
	const lines = normalized.split("\n");

	let first = 0;
	while (first < lines.length && lines[first]?.trim() === "") {
		first += 1;
	}
	let last = lines.length - 1;
	while (last >= first && lines[last]?.trim() === "") {
		last -= 1;
	}
	if (first > last) {
		throw new Error("Patch parse failed: patch is empty");
	}
	if (lines[first] !== BEGIN_MARKER || lines[last] !== END_MARKER) {
		throw new Error("Patch parse failed: missing Begin/End markers");
	}

	const parsed: ParsedPatch[] = [];
	let index = first + 1;
	while (index < last) {
		const line = lines[index] ?? "";
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		const header = parsePatchHeader(line);
		if (!header) {
			throw new Error(
				`Patch parse failed: unexpected line outside file section (line ${index + 1})`,
			);
		}

		if (header.kind === "add") {
			const addResult = parseAddFileLines(lines, index + 1, last);
			parsed.push({
				type: "add",
				filePath: header.filePath,
				lines: addResult.lines,
			});
			index = addResult.nextIndex;
			continue;
		}

		if (header.kind === "delete") {
			parsed.push({
				type: "delete",
				filePath: header.filePath,
			});
			index += 1;
			continue;
		}

		let moveTo: string | undefined;
		let nextIndex = index + 1;
		const maybeMove = lines[nextIndex] ?? "";
		if (maybeMove.startsWith("*** Move to: ")) {
			moveTo = requirePatchPath(
				"Move to",
				maybeMove.slice("*** Move to: ".length),
			);
			nextIndex += 1;
		}
		const updateResult = parseUpdateChunks(lines, nextIndex, last, {
			allowEmpty: Boolean(moveTo),
		});
		parsed.push({
			type: "update",
			filePath: header.filePath,
			...(moveTo ? { moveTo } : {}),
			chunks: updateResult.chunks,
		});
		index = updateResult.nextIndex;
	}

	if (parsed.length === 0) {
		throw new Error("Patch parse failed: no file changes found");
	}
	return parsed;
};

const renderAddedFile = (lines: string[]): string =>
	lines.length > 0 ? `${lines.join("\n")}\n` : "";

const normalizeUnicodeLikePatch = (value: string): string =>
	value
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\u00A0/g, " ");

const tryMatchSequence = (
	lines: string[],
	pattern: string[],
	startIndex: number,
	eof: boolean,
	compare: (left: string, right: string) => boolean,
): number => {
	if (pattern.length === 0) return -1;

	if (eof) {
		const fromEnd = lines.length - pattern.length;
		if (fromEnd >= startIndex) {
			let matches = true;
			for (let index = 0; index < pattern.length; index += 1) {
				if (!compare(lines[fromEnd + index] ?? "", pattern[index] ?? "")) {
					matches = false;
					break;
				}
			}
			if (matches) {
				return fromEnd;
			}
		}
	}

	for (
		let index = startIndex;
		index <= lines.length - pattern.length;
		index += 1
	) {
		let matches = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (!compare(lines[index + offset] ?? "", pattern[offset] ?? "")) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return index;
		}
	}
	return -1;
};

const seekSequence = (
	lines: string[],
	pattern: string[],
	startIndex: number,
	eof = false,
): number => {
	const exact = tryMatchSequence(
		lines,
		pattern,
		startIndex,
		eof,
		(left, right) => {
			return left === right;
		},
	);
	if (exact !== -1) return exact;

	const trimRight = tryMatchSequence(
		lines,
		pattern,
		startIndex,
		eof,
		(left, right) => left.trimEnd() === right.trimEnd(),
	);
	if (trimRight !== -1) return trimRight;

	const trimBoth = tryMatchSequence(
		lines,
		pattern,
		startIndex,
		eof,
		(left, right) => left.trim() === right.trim(),
	);
	if (trimBoth !== -1) return trimBoth;

	return tryMatchSequence(lines, pattern, startIndex, eof, (left, right) => {
		return (
			normalizeUnicodeLikePatch(left.trim()) ===
			normalizeUnicodeLikePatch(right.trim())
		);
	});
};

const applyLineReplacements = (
	lines: string[],
	replacements: LineReplacement[],
): string[] => {
	const result = [...lines];
	for (let index = replacements.length - 1; index >= 0; index -= 1) {
		const replacement = replacements[index];
		result.splice(
			replacement.startIndex,
			replacement.deleteCount,
			...replacement.insertLines,
		);
	}
	return result;
};

const computeLineReplacements = (
	lines: string[],
	filePath: string,
	chunks: PatchChunk[],
): LineReplacement[] => {
	const replacements: LineReplacement[] = [];
	let cursor = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext) {
			const contextIndex = seekSequence(
				lines,
				[chunk.changeContext],
				cursor,
				false,
			);
			if (contextIndex === -1) {
				throw new Error(
					`Patch apply failed: context '${chunk.changeContext}' not found in ${filePath}`,
				);
			}
			cursor = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			const insertAt = chunk.isEndOfFile ? lines.length : cursor;
			replacements.push({
				startIndex: insertAt,
				deleteCount: 0,
				insertLines: chunk.newLines,
			});
			cursor = insertAt;
			continue;
		}

		const matchIndex = seekSequence(
			lines,
			chunk.oldLines,
			cursor,
			chunk.isEndOfFile ?? false,
		);
		if (matchIndex === -1) {
			throw new Error(
				`Patch apply failed: expected lines not found in ${filePath}`,
			);
		}
		replacements.push({
			startIndex: matchIndex,
			deleteCount: chunk.oldLines.length,
			insertLines: chunk.newLines,
		});
		cursor = matchIndex + chunk.oldLines.length;
	}

	return replacements;
};

const deriveUpdatedContent = (
	filePath: string,
	before: string,
	chunks: PatchChunk[],
): string => {
	const hadTrailingNewline = before.endsWith("\n");
	const lines = before.split("\n");
	if (hadTrailingNewline && lines.at(-1) === "") {
		lines.pop();
	}
	const replacements = computeLineReplacements(lines, filePath, chunks);
	const nextLines = applyLineReplacements(lines, replacements);
	const joined = nextLines.join("\n");
	if (joined === "") {
		return "";
	}
	return hadTrailingNewline ? `${joined}\n` : joined;
};

const rewriteDiffPaths = (
	diff: string,
	oldPath: string,
	newPath: string,
): string => {
	if (!diff) return diff;
	const lines = diff.split("\n");
	if (lines.length >= 2) {
		lines[0] = `--- ${oldPath}`;
		lines[1] = `+++ ${newPath}`;
	}
	return lines.join("\n");
};

const ensureFileText = async (
	resolvedPath: string,
	filePath: string,
): Promise<string> => {
	try {
		const stats = await fs.stat(resolvedPath);
		if (stats.isDirectory()) {
			throw new Error(`Path is a directory: ${filePath}`);
		}
		return await fs.readFile(resolvedPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
};

const ensureFileStats = async (
	resolvedPath: string,
	filePath: string,
): Promise<import("node:fs").Stats> => {
	try {
		const stats = await fs.stat(resolvedPath);
		if (stats.isDirectory()) {
			throw new Error(`Path is a directory: ${filePath}`);
		}
		return stats;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
};

const preparePatchChanges = async (
	patches: ParsedPatch[],
	sandbox: SandboxContext,
): Promise<PreparedPatchChange[]> => {
	const prepared: PreparedPatchChange[] = [];
	const seenSources = new Set<string>();
	const seenTargets = new Set<string>();
	const vacatedEarlier = new Set<string>();

	for (const patch of patches) {
		const resolvedPath = sandbox.resolvePath(patch.filePath);
		if (seenSources.has(resolvedPath)) {
			throw new Error(
				`Patch apply failed: duplicate source path ${patch.filePath}`,
			);
		}
		seenSources.add(resolvedPath);

		if (patch.type === "add") {
			try {
				await fs.stat(resolvedPath);
				throw new Error(`File already exists: ${patch.filePath}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			if (seenTargets.has(resolvedPath)) {
				throw new Error(
					`Patch apply failed: duplicate target path ${patch.filePath}`,
				);
			}
			seenTargets.add(resolvedPath);
			const after = renderAddedFile(patch.lines);
			prepared.push({
				kind: "add",
				filePath: patch.filePath,
				resolvedPath,
				before: "",
				after,
				diff: createUnifiedDiff(patch.filePath, "", after),
			});
			continue;
		}

		if (patch.type === "delete") {
			const before = await ensureFileText(resolvedPath, patch.filePath);
			prepared.push({
				kind: "delete",
				filePath: patch.filePath,
				resolvedPath,
				before,
				after: "",
				diff: createUnifiedDiff(patch.filePath, before, ""),
			});
			vacatedEarlier.add(resolvedPath);
			continue;
		}

		const sourceStats = await ensureFileStats(resolvedPath, patch.filePath);
		const before = await fs.readFile(resolvedPath, "utf8");
		const after = deriveUpdatedContent(patch.filePath, before, patch.chunks);
		if (patch.moveTo) {
			const resolvedMoveTo = sandbox.resolvePath(patch.moveTo);
			if (resolvedMoveTo !== resolvedPath) {
				try {
					await fs.stat(resolvedMoveTo);
					if (!vacatedEarlier.has(resolvedMoveTo)) {
						throw new Error(`Move target already exists: ${patch.moveTo}`);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
				}
			}
			if (seenTargets.has(resolvedMoveTo)) {
				throw new Error(
					`Patch apply failed: duplicate target path ${patch.moveTo}`,
				);
			}
			seenTargets.add(resolvedMoveTo);
			prepared.push({
				kind: resolvedMoveTo === resolvedPath ? "update" : "move",
				filePath: patch.filePath,
				resolvedPath,
				moveTo: patch.moveTo,
				resolvedMoveTo,
				sourceMode: sourceStats.mode,
				before,
				after,
				diff:
					resolvedMoveTo === resolvedPath
						? createUnifiedDiff(patch.filePath, before, after)
						: rewriteDiffPaths(
								createUnifiedDiff(patch.filePath, before, after),
								patch.filePath,
								patch.moveTo,
							),
			});
			if (resolvedMoveTo !== resolvedPath) {
				vacatedEarlier.add(resolvedPath);
			}
			continue;
		}

		if (seenTargets.has(resolvedPath)) {
			throw new Error(
				`Patch apply failed: duplicate target path ${patch.filePath}`,
			);
		}
		seenTargets.add(resolvedPath);
		prepared.push({
			kind: "update",
			filePath: patch.filePath,
			resolvedPath,
			before,
			after,
			diff: createUnifiedDiff(patch.filePath, before, after),
		});
	}

	return prepared;
};

const applyPreparedChanges = async (
	changes: PreparedPatchChange[],
): Promise<void> => {
	for (const change of changes) {
		if (change.kind === "delete") {
			await fs.unlink(change.resolvedPath);
			continue;
		}

		if (change.kind === "move" && change.resolvedMoveTo) {
			await fs.mkdir(path.dirname(change.resolvedMoveTo), { recursive: true });
			await fs.writeFile(change.resolvedMoveTo, change.after, "utf8");
			if (typeof change.sourceMode === "number") {
				await fs.chmod(change.resolvedMoveTo, change.sourceMode);
			}
			await fs.unlink(change.resolvedPath);
			continue;
		}

		await fs.mkdir(path.dirname(change.resolvedPath), { recursive: true });
		await fs.writeFile(change.resolvedPath, change.after, "utf8");
	}
};

const summarizeChanges = (
	changes: PreparedPatchChange[],
	dryRun: boolean,
): { summary: string; files: PatchFileSummary[] } => {
	const fileSummaries: PatchFileSummary[] = changes.map((change) => {
		switch (change.kind) {
			case "add":
				return {
					action: "add",
					file_path: change.filePath,
					summary: `A ${change.filePath}`,
				};
			case "delete":
				return {
					action: "delete",
					file_path: change.filePath,
					summary: `D ${change.filePath}`,
				};
			case "move":
				return {
					action: "move",
					file_path: change.filePath,
					move_to: change.moveTo,
					summary: `R ${change.filePath} -> ${change.moveTo}`,
				};
			case "update":
				return {
					action: "update",
					file_path: change.moveTo ?? change.filePath,
					summary: `M ${change.moveTo ?? change.filePath}`,
				};
			default:
				throw new Error(`Unsupported patch change kind: ${change.kind}`);
		}
	});

	return {
		summary: dryRun
			? `Patch preview ready for ${changes.length} file(s)`
			: `Applied patch to ${changes.length} file(s)`,
		files: fileSummaries,
	};
};

export const createApplyPatchTool = (
	sandboxKey: DependencyKey<SandboxContext>,
	outputCacheStore?: ToolOutputCacheStore | null,
): Tool =>
	defineTool({
		name: "apply_patch",
		description:
			"Apply a codex-style multi-file patch; use dry_run to preview only.",
		input: z.object({
			patch: z
				.string()
				.min(1)
				.describe("Full patch text between *** Begin Patch and *** End Patch."),
			dry_run: z
				.boolean()
				.optional()
				.describe("Preview the patch without writing files. Default false."),
		}),
		execute: async (input, ctx) => {
			const dryRun = input.dry_run ?? false;
			const sandbox = await getSandboxContext(ctx, sandboxKey);
			const patches = parsePatch(input.patch);
			const prepared = await preparePatchChanges(patches, sandbox);
			const fullDiff = prepared
				.map((change) => change.diff)
				.filter((diff) => diff.length > 0)
				.join("\n\n");
			const diffPayload = await buildDiffPayload({
				toolName: "apply_patch",
				diff: fullDiff,
				outputCacheStore,
			});
			const summary = summarizeChanges(prepared, dryRun);

			if (!dryRun) {
				try {
					await applyPreparedChanges(prepared);
				} catch (error) {
					throw new Error(`Error applying patch: ${String(error)}`);
				}
			}

			return {
				summary: summary.summary,
				file_count: prepared.length,
				files: summary.files,
				...diffPayload,
			};
		},
	});
