import { promises as fs } from "node:fs";
import type { DependencyKey, Tool, ToolContext } from "@codelia/core";
import { getSandboxContext, type SandboxContext } from "../sandbox/context";
import { createUnifiedDiff } from "../utils/diff";
import { resolvePreviewLanguageHint } from "../utils/language";

const MAX_CONFIRM_PREVIEW_LINES = 120;

export type PermissionPreview = {
	diff: string | null;
	summary: string | null;
	truncated: boolean;
	filePath: string | null;
	language: string | null;
};

export type PermissionPreviewInput = {
	tool: string;
	rawArgs: string;
	toolContext: ToolContext;
	sandboxKey: DependencyKey<SandboxContext> | null;
	editTool?: Tool;
	applyPatchTool?: Tool;
};

const emptyPreview = (): PermissionPreview => ({
	diff: null,
	summary: null,
	truncated: false,
	filePath: null,
	language: null,
});

const splitLines = (value: string): string[] =>
	value.split("\n").map((line) => line.replace(/\r$/, ""));

const buildBoundedDiffPreview = (
	diff: string,
	maxLines = MAX_CONFIRM_PREVIEW_LINES,
): Pick<PermissionPreview, "diff" | "truncated"> => {
	if (!diff.trim()) return { diff: null, truncated: false };
	const lines = splitLines(diff);
	if (!lines.length) return { diff: null, truncated: false };
	if (lines.length <= maxLines) {
		return { diff: lines.join("\n"), truncated: false };
	}
	return {
		diff: lines.slice(0, maxLines).join("\n"),
		truncated: true,
	};
};

const parseToolArgsObject = (
	rawArgs: string,
): Record<string, unknown> | null => {
	try {
		const parsed = JSON.parse(rawArgs) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return null;
		}
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
};

const unwrapToolJsonObject = (
	result: unknown,
): Record<string, unknown> | null => {
	if (!result || typeof result !== "object") return null;
	const typed = result as Record<string, unknown>;
	if (typed.type !== "json") return null;
	const value = typed.value;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
};

const buildWritePreview = async (
	input: PermissionPreviewInput,
): Promise<PermissionPreview> => {
	const preview = emptyPreview();
	const parsed = parseToolArgsObject(input.rawArgs);
	const filePath =
		typeof parsed?.file_path === "string" ? parsed.file_path : "";
	const content = typeof parsed?.content === "string" ? parsed.content : "";
	const language = typeof parsed?.language === "string" ? parsed.language : "";
	if (!filePath) return preview;
	preview.filePath = filePath;
	preview.language =
		resolvePreviewLanguageHint({
			language,
			filePath,
			content,
		}) ?? null;
	try {
		if (!input.sandboxKey) {
			throw new Error("sandbox is unavailable");
		}
		const sandbox = await getSandboxContext(
			input.toolContext,
			input.sandboxKey,
		);
		const resolved = sandbox.resolvePath(filePath);
		let before = "";
		try {
			const stat = await fs.stat(resolved);
			if (!stat.isDirectory()) {
				before = await fs.readFile(resolved, "utf8");
			}
		} catch {
			before = "";
		}
		const bounded = buildBoundedDiffPreview(
			createUnifiedDiff(filePath, before, content),
		);
		preview.diff = bounded.diff;
		preview.truncated = bounded.truncated;
	} catch {
		preview.diff = null;
		preview.summary = null;
		preview.truncated = false;
	}
	return preview;
};

const buildEditPreview = async (
	input: PermissionPreviewInput,
): Promise<PermissionPreview> => {
	const preview = emptyPreview();
	if (!input.editTool) return preview;
	const parsed = parseToolArgsObject(input.rawArgs);
	if (!parsed) return preview;
	const filePath = typeof parsed.file_path === "string" ? parsed.file_path : "";
	const language = typeof parsed.language === "string" ? parsed.language : "";
	preview.filePath = filePath || null;
	preview.language = resolvePreviewLanguageHint({ language, filePath }) ?? null;
	try {
		const result = await input.editTool.executeRaw(
			JSON.stringify({ ...parsed, dry_run: true }),
			input.toolContext,
		);
		if (!result || typeof result !== "object") return preview;
		const obj = unwrapToolJsonObject(result);
		if (!obj) {
			preview.summary = "Preview unavailable: unexpected dry-run output";
			return preview;
		}
		const resultFilePath =
			typeof obj.file_path === "string" ? obj.file_path : "";
		const resultLanguage = typeof obj.language === "string" ? obj.language : "";
		if (!preview.filePath && resultFilePath) {
			preview.filePath = resultFilePath;
		}
		const diff = typeof obj.diff === "string" ? obj.diff : "";
		const summary = typeof obj.summary === "string" ? obj.summary : "";
		preview.language =
			resolvePreviewLanguageHint({
				language: resultLanguage || preview.language,
				filePath: preview.filePath || resultFilePath,
				diff,
			}) ?? preview.language;
		const bounded = buildBoundedDiffPreview(diff);
		preview.diff = bounded.diff;
		preview.truncated = bounded.truncated;
		if (!preview.diff) {
			preview.summary = summary || "Preview: no diff content";
		}
	} catch {
		preview.summary = "Preview unavailable: dry-run failed";
	}
	return preview;
};

const buildApplyPatchPreview = async (
	input: PermissionPreviewInput,
): Promise<PermissionPreview> => {
	const preview = emptyPreview();
	if (!input.applyPatchTool) return preview;
	const parsed = parseToolArgsObject(input.rawArgs);
	if (!parsed) return preview;
	try {
		const result = await input.applyPatchTool.executeRaw(
			JSON.stringify({ ...parsed, dry_run: true }),
			input.toolContext,
		);
		if (!result || typeof result !== "object") return preview;
		const obj = unwrapToolJsonObject(result);
		if (!obj) {
			preview.summary = "Preview unavailable: unexpected dry-run output";
			return preview;
		}
		const diff = typeof obj.diff === "string" ? obj.diff : "";
		const summary = typeof obj.summary === "string" ? obj.summary : "";
		const bounded = buildBoundedDiffPreview(diff);
		preview.diff = bounded.diff;
		preview.truncated = bounded.truncated;
		if (!preview.diff) {
			preview.summary = summary || "Preview: no diff content";
		}
	} catch {
		preview.summary = "Preview unavailable: dry-run failed";
	}
	return preview;
};

export const buildPermissionPreview = async (
	input: PermissionPreviewInput,
): Promise<PermissionPreview> => {
	let preview: PermissionPreview;
	switch (input.tool) {
		case "write":
			preview = await buildWritePreview(input);
			break;
		case "edit":
			preview = await buildEditPreview(input);
			break;
		case "apply_patch":
			preview = await buildApplyPatchPreview(input);
			break;
		default:
			preview = emptyPreview();
	}
	preview.language =
		resolvePreviewLanguageHint({
			language: preview.language,
			filePath: preview.filePath,
			diff: preview.diff,
		}) ?? preview.language;
	return preview;
};
