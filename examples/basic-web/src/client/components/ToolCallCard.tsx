import { useState } from "react";
import type { ToolCallEvent, ToolResultEvent } from "../../shared/types";

type Props = {
	call: ToolCallEvent;
	result?: ToolResultEvent;
};

const MAX_SUMMARY = 120;
const PREVIEW_LINES = 5;

const truncate = (s: string, max: number): string =>
	s.length > max ? `${s.slice(0, max - 3)}...` : s;

const summarizeToolCall = (
	tool: string,
	args: Record<string, unknown>,
): string => {
	if (tool === "read") {
		const path = typeof args.file_path === "string" ? args.file_path : "";
		const parts: string[] = [];
		if (typeof args.offset === "number") parts.push(`offset=${args.offset}`);
		if (typeof args.limit === "number") parts.push(`limit=${args.limit}`);
		const range = parts.length ? ` (${parts.join(", ")})` : "";
		return `${path}${range}`;
	}
	if (tool === "write" || tool === "edit") {
		return typeof args.file_path === "string" ? args.file_path : "";
	}
	if (tool === "bash") {
		return typeof args.command === "string"
			? truncate(args.command, MAX_SUMMARY)
			: "";
	}
	if (tool === "glob_search") {
		return typeof args.pattern === "string" ? args.pattern : "";
	}
	if (tool === "grep") {
		return typeof args.pattern === "string"
			? truncate(args.pattern, MAX_SUMMARY)
			: "";
	}
	return truncate(JSON.stringify(args), MAX_SUMMARY);
};

const looksLikeError = (
	tool: string,
	text: string,
	isError?: boolean,
): boolean => {
	if (isError) return true;
	const lower = text.toLowerCase();
	if (lower.startsWith("error:") || lower.startsWith("security error"))
		return true;
	if (lower.startsWith("command timed out")) return true;
	if (tool === "read") {
		return (
			lower.startsWith("file not found") ||
			lower.startsWith("path is a directory")
		);
	}
	return false;
};

const parseEditResult = (
	raw: string,
): { summary: string; diff: string | null } | null => {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "summary" in parsed) {
			return {
				summary: String(parsed.summary),
				diff: typeof parsed.diff === "string" ? parsed.diff : null,
			};
		}
	} catch {
		// ignore parse errors
	}
	return null;
};

const getResultSummary = (
	tool: string,
	raw: string,
	isError?: boolean,
): string => {
	const errored = looksLikeError(tool, raw, isError);
	if (tool === "edit") {
		const edit = parseEditResult(raw);
		if (edit) return edit.summary;
	}
	if (tool === "bash") {
		if (!raw.trim() || raw.trim() === "(no output)") return "(no output)";
	}
	const firstLine = raw.split("\n")[0] ?? "";
	if (errored) return truncate(firstLine, 80);
	return truncate(firstLine, 80);
};

const DiffBlock = ({ diff }: { diff: string }) => {
	const lines = diff.split("\n");
	const duplicateCounts = new Map<string, number>();
	return (
		<pre className="az-diff">
			{lines.map((line) => {
				const seen = (duplicateCounts.get(line) ?? 0) + 1;
				duplicateCounts.set(line, seen);
				const lineKey = `${line}:${seen}`;
				let className = "az-diff-line";
				if (line.startsWith("+") && !line.startsWith("+++")) {
					className += " is-add";
				} else if (line.startsWith("-") && !line.startsWith("---")) {
					className += " is-remove";
				} else if (line.startsWith("@@")) {
					className += " is-hunk";
				}
				return (
					<div key={lineKey} className={className}>
						{line}
					</div>
				);
			})}
		</pre>
	);
};

const ResultPreview = ({
	tool,
	raw,
	isError,
}: {
	tool: string;
	raw: string;
	isError?: boolean;
}) => {
	const errored = looksLikeError(tool, raw, isError);

	if (tool === "edit") {
		const edit = parseEditResult(raw);
		if (edit) {
			return (
				<div>
					<div className={`az-result-summary${errored ? " is-error" : ""}`}>
						{edit.summary}
					</div>
					{edit.diff ? <DiffBlock diff={edit.diff} /> : null}
				</div>
			);
		}
	}

	const lines = raw.split("\n").filter((line) => line.length > 0);
	const preview = lines.slice(0, PREVIEW_LINES);
	const truncated = lines.length > PREVIEW_LINES;

	return (
		<pre className={`az-result-preview${errored ? " is-error" : ""}`}>
			{preview.join("\n")}
			{truncated ? "\n... (truncated)" : ""}
		</pre>
	);
};

export const ToolCallCard = ({ call, result }: Props) => {
	const [expanded, setExpanded] = useState(false);
	const isPending = !result;
	const isError = result
		? looksLikeError(call.tool, result.result, result.is_error)
		: false;
	const status = isPending ? "running" : isError ? "error" : "done";

	const summary = summarizeToolCall(call.tool, call.args);
	const resultSummary = result
		? getResultSummary(call.tool, result.result, result.is_error)
		: "";

	return (
		<div className={`az-tool-card is-${status}`}>
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				className="az-tool-head"
			>
				<span className="az-tool-name">{call.tool}</span>
				<span className="az-tool-summary">{summary}</span>
				<span className="az-tool-status">{status}</span>
				<span className="az-chevron">{expanded ? "^" : "v"}</span>
			</button>

			{result && !expanded && resultSummary ? (
				<div className={`az-tool-collapsed${isError ? " is-error" : ""}`}>
					{"->"} {resultSummary}
				</div>
			) : null}

			{expanded ? (
				<div className="az-tool-body">
					<div className="az-tool-section">
						<p className="az-tool-label">Arguments</p>
						<pre className="az-tool-json">
							{JSON.stringify(call.args, null, 2)}
						</pre>
					</div>
					{result ? (
						<div className="az-tool-section">
							<p className="az-tool-label">Result</p>
							<ResultPreview
								tool={call.tool}
								raw={result.result}
								isError={result.is_error}
							/>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
};
