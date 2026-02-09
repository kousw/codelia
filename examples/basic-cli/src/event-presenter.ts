import type { AgentEvent, ToolResultEvent } from "@codelia/core";

const READ_PREVIEW_LINES = 2;
const BASH_SUCCESS_LINES = 3;
const BASH_ERROR_LINES = 5;
const DEFAULT_PREVIEW_LINES = 3;
const MAX_DIFF_LINES = 200;
const MAX_ARG_LENGTH = 160;
const MAX_HEADER_LENGTH = 200;

const splitLines = (text: string): string[] =>
	text.split(/\r?\n/).map((line) => line.replace(/\r$/, ""));

const truncateLine = (text: string, max: number): string =>
	text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;

const limitLines = (
	lines: string[],
	max: number,
): { lines: string[]; truncated: boolean } => {
	if (lines.length <= max) return { lines, truncated: false };
	return { lines: lines.slice(0, max), truncated: true };
};

const redactRefMarkers = (text: string): string => {
	let output = text.replace(
		/\[tool output (truncated|trimmed); ref=[^\]]+\]/g,
		"[tool output $1]",
	);
	output = output.replace(/^ref:.*(?:\r?\n)?/gm, "");
	return output;
};

const safeJsonParse = (value: string): unknown | null => {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
};

const stringifyArgs = (args: Record<string, unknown>): string => {
	try {
		return JSON.stringify(args);
	} catch {
		return String(args);
	}
};

const summarizeToolCall = (
	tool: string,
	args: Record<string, unknown>,
): string => {
	const arg = args ?? {};
	if (tool === "read") {
		const path = typeof arg.file_path === "string" ? arg.file_path : "";
		const parts: string[] = [];
		if (typeof arg.offset === "number") parts.push(`offset=${arg.offset}`);
		if (typeof arg.limit === "number") parts.push(`limit=${arg.limit}`);
		const range = parts.length ? ` (${parts.join(", ")})` : "";
		return `read ${path}${range}`.trim();
	}
	if (tool === "write" || tool === "edit") {
		const path = typeof arg.file_path === "string" ? arg.file_path : "";
		return `${tool} ${path}`.trim();
	}
	if (tool === "bash") {
		const command = typeof arg.command === "string" ? arg.command : "";
		return `bash ${truncateLine(command, MAX_ARG_LENGTH)}`.trim();
	}
	if (tool === "tool_output_cache_grep") {
		const pattern = typeof arg.pattern === "string" ? arg.pattern : "";
		return `tool_output_cache_grep ${truncateLine(pattern, MAX_ARG_LENGTH)}`.trim();
	}
	if (tool === "tool_output_cache") {
		return "tool_output_cache";
	}
	const json = truncateLine(stringifyArgs(arg), MAX_ARG_LENGTH);
	return `${tool} ${json}`.trim();
};

const looksLikeError = (
	tool: string,
	text: string,
	isError?: boolean,
): boolean => {
	if (isError) return true;
	const lower = text.toLowerCase();
	if (lower.startsWith("error:")) return true;
	if (lower.startsWith("security error")) return true;
	if (lower.startsWith("command timed out")) return true;
	if (tool === "read") {
		return (
			lower.startsWith("file not found") ||
			lower.startsWith("path is a directory") ||
			lower.startsWith("offset exceeds") ||
			lower.startsWith("error reading")
		);
	}
	return false;
};

const previewLines = (
	text: string,
	maxLines: number,
): { lines: string[]; truncated: boolean } => {
	const lines = splitLines(text).filter((line) => line.length > 0);
	return limitLines(lines, maxLines);
};

const formatPreviewBlock = (lines: string[], truncated: boolean): string[] => {
	if (lines.length === 0) return [];
	const block = [...lines];
	if (truncated) block.push("... (truncated)");
	return block;
};

const formatToolResult = (event: ToolResultEvent): string[] => {
	const tool = event.tool;
	const rawText = String(event.result ?? "");
	const cleaned = redactRefMarkers(rawText).trim();
	const isError = looksLikeError(tool, cleaned, event.is_error);

	if (tool === "edit") {
		const parsed = safeJsonParse(rawText);
		if (parsed && typeof parsed === "object") {
			const summary = (parsed as { summary?: unknown }).summary;
			const diff = (parsed as { diff?: unknown }).diff;
			const header =
				typeof summary === "string"
					? truncateLine(summary, MAX_HEADER_LENGTH)
					: "edit result";
			if (typeof diff === "string" && diff.trim().length > 0) {
				const diffLines = splitLines(diff);
				const limited = limitLines(diffLines, MAX_DIFF_LINES);
				const details = formatPreviewBlock(limited.lines, limited.truncated);
				return [`  -> ${header}`, ...details.map((line) => `     ${line}`)];
			}
			return [`  -> ${header}`];
		}
	}

	if (tool === "bash") {
		if (cleaned === "" || cleaned === "(no output)") {
			return ["  -> bash (no output)"];
		}
		const preview = previewLines(
			cleaned,
			isError ? BASH_ERROR_LINES : BASH_SUCCESS_LINES,
		);
		const details = formatPreviewBlock(preview.lines, preview.truncated);
		const header = isError ? "bash error" : "bash output";
		return [`  -> ${header}`, ...details.map((line) => `     ${line}`)];
	}

	if (tool === "read") {
		if (!cleaned) {
			return [`  -> ${isError ? "read error" : "read output"}`];
		}
		const preview = previewLines(cleaned, READ_PREVIEW_LINES);
		const details = formatPreviewBlock(preview.lines, preview.truncated);
		const header = isError ? "read error" : "read output";
		return [`  -> ${header}`, ...details.map((line) => `     ${line}`)];
	}

	if (tool === "tool_output_cache_grep") {
		if (cleaned.startsWith("No matches for:")) {
			return [`  -> ${truncateLine(cleaned, MAX_HEADER_LENGTH)}`];
		}
		const matchCount = splitLines(rawText).filter((line) =>
			line.startsWith("ref:"),
		).length;
		const preview = previewLines(cleaned, DEFAULT_PREVIEW_LINES);
		const details = formatPreviewBlock(preview.lines, preview.truncated);
		return [
			`  -> grep matches: ${matchCount}`,
			...details.map((line) => `     ${line}`),
		];
	}

	if (tool === "tool_output_cache") {
		if (!cleaned) {
			return ["  -> cached output (empty)"];
		}
		const preview = previewLines(cleaned, DEFAULT_PREVIEW_LINES);
		const details = formatPreviewBlock(preview.lines, preview.truncated);
		return ["  -> cached output", ...details.map((line) => `     ${line}`)];
	}

	if (cleaned) {
		const preview = previewLines(cleaned, DEFAULT_PREVIEW_LINES);
		const details = formatPreviewBlock(preview.lines, preview.truncated);
		const header =
			preview.lines.length > 0
				? truncateLine(preview.lines[0], MAX_HEADER_LENGTH)
				: isError
					? "error"
					: "result";
		const remaining = details.slice(1);
		return [`  -> ${header}`, ...remaining.map((line) => `     ${line}`)];
	}

	return [`  -> ${isError ? "error" : "result"}`];
};

export const renderEvent = (event: AgentEvent): string[] => {
	switch (event.type) {
		case "text":
			return event.content ? [`\n${event.content}`] : [];
		case "final":
			return event.content ? [`\n${event.content}`] : [];
		case "reasoning":
			return event.content ? [`[thinking] ${event.content}`] : [];
		case "tool_call": {
			const summary = summarizeToolCall(event.tool, event.args ?? {});
			return [`[${event.tool}] ${summary}`.trim()];
		}
		case "tool_result":
			return formatToolResult(event);
		case "compaction_start":
			return ["[compaction] started"];
		case "compaction_complete":
			return [`[compaction] ${event.compacted ? "completed" : "skipped"}`];
		default:
			return [];
	}
};
