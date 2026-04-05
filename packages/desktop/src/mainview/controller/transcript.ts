import {
	type GeneratedUiDocument,
	isGeneratedUiDocument,
} from "../../../../protocol/src/index";
import type { ChatMessage } from "../../shared/types";

type ToolTimelineRow = {
	kind: "tool";
	toolCallId: string;
	label: string;
	summary: string;
	resultText?: string;
	permissionSummary?: string;
	permissionDiff?: string;
	status: "running" | "completed" | "error";
};

type TextTimelineRow = {
	kind: "text";
	content: string;
	finalized: boolean;
};

type GeneratedUiTimelineRow = {
	kind: "generated_ui";
	toolCallId: string;
	payload: GeneratedUiDocument;
};

type TimelineRow =
	| { kind: "html"; html: string }
	| ToolTimelineRow
	| TextTimelineRow
	| GeneratedUiTimelineRow;

export type AssistantRenderRow =
	| { kind: "html"; key: string; html: string }
	| {
			kind: "markdown";
			key: string;
			content: string;
			finalized: boolean;
	  }
	| {
			kind: "generated_ui";
			key: string;
			payload: GeneratedUiDocument;
	  };

const escapeHtml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

export const formatRelativeTime = (value: string): string => {
	const timestamp = new Date(value).getTime();
	if (Number.isNaN(timestamp)) return value;
	const diffMs = Date.now() - timestamp;
	const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
	if (diffMinutes < 1) return "now";
	if (diffMinutes < 60) return `${diffMinutes}m`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours}h`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) return `${diffDays}d`;
	const diffWeeks = Math.floor(diffDays / 7);
	if (diffWeeks < 5) return `${diffWeeks}w`;
	const diffMonths = Math.floor(diffDays / 30);
	if (diffMonths < 12) return `${diffMonths}mo`;
	const diffYears = Math.floor(diffDays / 365);
	return `${diffYears}y`;
};

const truncateText = (value: string, max = 120): string => {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, Math.max(0, max - 3))}...`;
};

const prettyJson = (value: unknown): string => {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

const parseGeneratedUiResult = (value: string): GeneratedUiDocument | null => {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isGeneratedUiDocument(parsed) ? parsed : null;
	} catch {
		return null;
	}
};

const firstMeaningfulLine = (value: string): string =>
	value
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";

const basename = (value: string): string => {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	const normalized = trimmed.replaceAll("\\", "/");
	return normalized.split("/").at(-1) ?? normalized;
};

const summarizeToolCall = (
	tool: string,
	args: Record<string, unknown>,
): { label: string; detail: string } => {
	if (tool === "shell") {
		const command =
			typeof args.command === "string" ? args.command.trim() : "(no command)";
		const detached =
			typeof args.detached_wait === "boolean" && args.detached_wait;
		return {
			label: "Shell",
			detail: detached
				? `${truncateText(command, 140)} (detached wait)`
				: truncateText(command, 140),
		};
	}
	if (tool === "webfetch") {
		return {
			label: "WebFetch",
			detail: truncateText(
				typeof args.url === "string" ? args.url : "(no url)",
				140,
			),
		};
	}
	if (tool === "web_search") {
		const query =
			typeof args.query === "string"
				? args.query
				: Array.isArray(args.queries)
					? (args.queries.find((value) => typeof value === "string") ?? "")
					: "";
		return {
			label: "WebSearch",
			detail: truncateText(query || "(search)", 140),
		};
	}
	if (tool === "read") {
		const fileName =
			typeof args.file_path === "string" ? basename(args.file_path) : "";
		const parts: string[] = [];
		if (typeof args.offset === "number") {
			parts.push(`offset=${args.offset}`);
		}
		if (typeof args.limit === "number") {
			parts.push(`limit=${args.limit}`);
		}
		return {
			label: "Read",
			detail: fileName
				? parts.length > 0
					? `${fileName} (${parts.join(", ")})`
					: fileName
				: "(no file)",
		};
	}
	if (tool === "read_line") {
		const fileName =
			typeof args.file_path === "string" ? basename(args.file_path) : "";
		const lineNumber =
			typeof args.line_number === "number" ? `:${args.line_number}` : "";
		return {
			label: "ReadLine",
			detail: fileName ? `${fileName}${lineNumber}` : "(no file)",
		};
	}
	if (tool === "write" || tool === "edit") {
		return {
			label: tool === "write" ? "Write" : "Edit",
			detail:
				typeof args.file_path === "string"
					? basename(args.file_path) || args.file_path
					: "(no file)",
		};
	}
	if (tool === "apply_patch") {
		const patch =
			typeof args.patch === "string" ? args.patch : prettyJson(args.patch);
		const fileCount = patch
			.split("\n")
			.filter(
				(line) =>
					line.startsWith("*** Update File: ") ||
					line.startsWith("*** Add File: ") ||
					line.startsWith("*** Delete File: "),
			).length;
		return {
			label: "ApplyPatch",
			detail: fileCount > 0 ? `${fileCount} file(s)` : "patch",
		};
	}
	if (tool === "ui_render") {
		const title =
			typeof args.title === "string" && args.title.trim()
				? args.title.trim()
				: "Generated panel";
		return {
			label: "UI",
			detail: truncateText(title, 140),
		};
	}
	if (tool === "view_image") {
		return {
			label: "ViewImage",
			detail:
				typeof args.file_path === "string"
					? basename(args.file_path) || args.file_path
					: "(no image)",
		};
	}
	return {
		label: tool,
		detail: truncateText(
			firstMeaningfulLine(prettyJson(args)) || "(no args)",
			140,
		),
	};
};

const summarizeToolResult = (
	tool: string,
	result: string,
	isError = false,
): string => {
	if (tool === "ui_render") {
		const generated = parseGeneratedUiResult(result);
		if (generated) {
			return truncateText(generated.summary || generated.title, 140);
		}
	}
	try {
		const parsed = JSON.parse(result) as Record<string, unknown>;
		if (typeof parsed.summary === "string" && parsed.summary.trim()) {
			return truncateText(parsed.summary.trim(), 140);
		}
		if (
			tool === "webfetch" &&
			typeof parsed.final_url === "string" &&
			parsed.final_url.trim()
		) {
			return truncateText(parsed.final_url.trim(), 140);
		}
		if (
			tool.startsWith("shell") &&
			typeof parsed.state === "string" &&
			parsed.state.trim()
		) {
			return truncateText(
				`${parsed.state}${typeof parsed.key === "string" ? ` · ${parsed.key}` : ""}`,
				140,
			);
		}
	} catch {
		// fall through to plain text summary
	}
	const line = firstMeaningfulLine(result);
	if (line) {
		return truncateText(line, 140);
	}
	return isError ? "Command failed" : "Completed";
};

const renderTimelineNote = (
	label: string,
	summary?: string,
	tone: "default" | "warning" | "error" = "default",
): string => {
	return `<div class="timeline-note${tone !== "default" ? ` is-${tone}` : ""}">
		<span class="timeline-note-label">${escapeHtml(label)}</span>
		${
			summary
				? `<span class="timeline-note-summary">${escapeHtml(summary)}</span>`
				: ""
		}
	</div>`;
};

const renderDetailSection = (
	label: string,
	body: string,
	options?: { scrollable?: boolean },
): string => {
	return `<section class="timeline-detail-section${
		options?.scrollable ? " is-scrollable" : ""
	}">
		<div class="timeline-detail-head">
			<div class="timeline-detail-label">${escapeHtml(label)}</div>
			<button type="button" class="copy-chip" data-action="copy-section">Copy</button>
		</div>
		<pre>${escapeHtml(body)}</pre>
	</section>`;
};

const renderToolTimelineRow = (row: ToolTimelineRow): string => {
	const stateLabel =
		row.status === "error"
			? "error"
			: row.status === "completed"
				? "done"
				: "running";
	const detailSections = [
		row.permissionDiff || row.permissionSummary
			? renderDetailSection(
					"Permission",
					[row.permissionSummary, row.permissionDiff]
						.filter((value): value is string => Boolean(value))
						.join("\n\n"),
				)
			: "",
		row.resultText
			? renderDetailSection(
					row.status === "error" ? "Result (error)" : "Result",
					row.resultText,
					{ scrollable: true },
				)
			: "",
	].filter(Boolean);
	return `<details class="timeline-item timeline-tool is-${stateLabel}">
		<summary>
			<span class="timeline-label">${escapeHtml(row.label)}</span>
			<span class="timeline-summary">${escapeHtml(row.summary)}</span>
			<span class="timeline-state is-${stateLabel}">${escapeHtml(
				row.status === "error"
					? "Error"
					: row.status === "completed"
						? "Done"
						: "Running",
			)}</span>
		</summary>
		${
			detailSections.length > 0
				? `<div class="timeline-detail">${detailSections.join("")}</div>`
				: ""
		}
	</details>`;
};

const summarizeReadGroup = (rows: ToolTimelineRow[]): string => {
	const items = rows
		.map((row) => row.summary.replace(/\s+\(.+?\)$/, "").trim())
		.filter(Boolean);
	if (items.length === 0) {
		return `${rows.length} files`;
	}
	if (items.length === 1) {
		return items[0];
	}
	if (items.length === 2) {
		return `${items[0]}, ${items[1]}`;
	}
	return `${items[0]}, ${items[1]} +${items.length - 2}`;
};

const summarizeGroupedStatus = (
	rows: ToolTimelineRow[],
): "running" | "completed" | "error" => {
	if (rows.some((row) => row.status === "error")) {
		return "error";
	}
	if (rows.some((row) => row.status === "running")) {
		return "running";
	}
	return "completed";
};

const renderNestedToolRow = (row: ToolTimelineRow): string => {
	const stateLabel =
		row.status === "error"
			? "error"
			: row.status === "completed"
				? "done"
				: "running";
	const detailSections = [
		row.permissionDiff || row.permissionSummary
			? renderDetailSection(
					"Permission",
					[row.permissionSummary, row.permissionDiff]
						.filter((value): value is string => Boolean(value))
						.join("\n\n"),
				)
			: "",
		row.resultText
			? renderDetailSection(
					row.status === "error" ? "Result (error)" : "Result",
					row.resultText,
					{ scrollable: true },
				)
			: "",
	].filter(Boolean);
	return `<details class="timeline-subitem is-${stateLabel}">
		<summary>
			<span class="timeline-substate is-${stateLabel}"></span>
			<span class="timeline-subsummary">${escapeHtml(row.summary)}</span>
		</summary>
		${
			detailSections.length > 0
				? `<div class="timeline-subdetail">${detailSections.join("")}</div>`
				: ""
		}
	</details>`;
};

const renderReadGroupTimelineRow = (rows: ToolTimelineRow[]): string => {
	const stateLabel = summarizeGroupedStatus(rows);
	return `<details class="timeline-item timeline-tool is-${stateLabel}">
		<summary>
			<span class="timeline-label">Read</span>
			<span class="timeline-summary">${escapeHtml(summarizeReadGroup(rows))}</span>
			<span class="timeline-state is-${stateLabel}"></span>
		</summary>
		<div class="timeline-detail">
			<div class="timeline-substack">
				${rows.map((row) => renderNestedToolRow(row)).join("")}
			</div>
		</div>
	</details>`;
};

export const buildAssistantRenderRows = (
	events: ChatMessage["events"],
): AssistantRenderRow[] => {
	const rows: TimelineRow[] = [];
	const toolRowIndexes = new Map<string, number>();

	for (const event of events) {
		if (event.type === "text") {
			const last = rows.at(-1);
			if (last && last.kind === "text" && !last.finalized) {
				last.content += event.content;
			} else {
				rows.push({
					kind: "text",
					content: event.content,
					finalized: false,
				});
			}
			continue;
		}
		if (event.type === "final") {
			const last = rows.at(-1);
			if (last && last.kind === "text") {
				last.content = event.content;
				last.finalized = true;
			} else {
				rows.push({
					kind: "text",
					content: event.content,
					finalized: true,
				});
			}
			continue;
		}
		if (event.type === "reasoning") {
			rows.push({
				kind: "html",
				html: `<details class="timeline-item">
					<summary><span class="timeline-label">Reasoning</span><span class="timeline-summary">${escapeHtml(
						truncateText(firstMeaningfulLine(event.content) || "Thinking", 120),
					)}</span></summary>
					<div class="timeline-detail">${renderDetailSection("Trace", event.content)}</div>
				</details>`,
			});
			continue;
		}
		if (event.type === "step_start" || event.type === "step_complete") {
			continue;
		}
		if (event.type === "compaction_start") {
			rows.push({
				kind: "html",
				html: renderTimelineNote("Compaction", "Running", "warning"),
			});
			continue;
		}
		if (event.type === "compaction_complete") {
			rows.push({
				kind: "html",
				html: renderTimelineNote(
					"Compaction",
					event.compacted ? "Completed" : "Skipped",
					"default",
				),
			});
			continue;
		}
		if (event.type === "permission.ready") {
			rows.push({
				kind: "html",
				html: renderTimelineNote(
					"Permission",
					`${event.tool} ready`,
					"warning",
				),
			});
			continue;
		}
		if (event.type === "tool_call") {
			const summary = summarizeToolCall(
				event.display_name ?? event.tool,
				event.args,
			);
			toolRowIndexes.set(event.tool_call_id, rows.length);
			rows.push({
				kind: "tool",
				toolCallId: event.tool_call_id,
				label: summary.label,
				summary: summary.detail,
				status: "running",
			});
			continue;
		}
		if (event.type === "permission.preview") {
			const rowIndex = event.tool_call_id
				? toolRowIndexes.get(event.tool_call_id)
				: undefined;
			const row = rowIndex !== undefined ? rows[rowIndex] : undefined;
			if (row && row.kind === "tool") {
				row.permissionSummary = event.summary ?? `${event.tool} preview`;
				row.permissionDiff = event.diff;
				continue;
			}
			rows.push({
				kind: "html",
				html: `<details class="timeline-item">
					<summary><span class="timeline-label">Permission</span><span class="timeline-summary">${escapeHtml(
						event.summary ?? `${event.tool} preview`,
					)}</span></summary>
					<div class="timeline-detail">${
						event.diff ? renderDetailSection("Diff", event.diff) : ""
					}</div>
				</details>`,
			});
			continue;
		}
		if (event.type === "tool_result") {
			const rowIndex = toolRowIndexes.get(event.tool_call_id);
			if (event.tool === "ui_render" && !event.is_error) {
				const generated = parseGeneratedUiResult(event.result);
				if (generated) {
					if (rowIndex !== undefined) {
						rows[rowIndex] = {
							kind: "generated_ui",
							toolCallId: event.tool_call_id,
							payload: generated,
						};
						continue;
					}
					rows.push({
						kind: "generated_ui",
						toolCallId: event.tool_call_id,
						payload: generated,
					});
					continue;
				}
			}
			const summary = summarizeToolResult(
				event.tool,
				event.result,
				event.is_error,
			);
			if (rowIndex !== undefined) {
				const row = rows[rowIndex];
				if (row && row.kind === "tool") {
					row.resultText = event.result;
					row.status = event.is_error ? "error" : "completed";
					row.summary = summary;
					continue;
				}
			}
			rows.push({
				kind: "tool",
				toolCallId: event.tool_call_id,
				label: event.tool,
				summary,
				resultText: event.result,
				status: event.is_error ? "error" : "completed",
			});
		}
	}

	const renderRows: AssistantRenderRow[] = [];
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (row.kind === "html") {
			renderRows.push({
				kind: "html",
				key: `html-${index}`,
				html: row.html,
			});
			continue;
		}
		if (row.kind === "text") {
			renderRows.push({
				kind: "markdown",
				key: `markdown-${index}`,
				content: row.content,
				finalized: row.finalized,
			});
			continue;
		}
		if (row.kind === "generated_ui") {
			renderRows.push({
				kind: "generated_ui",
				key: `generated-ui-${index}`,
				payload: row.payload,
			});
			continue;
		}
		if (row.kind === "tool" && row.label === "Read") {
			const groupedRows = [row];
			while (index + 1 < rows.length) {
				const nextRow = rows[index + 1];
				if (nextRow?.kind !== "tool" || nextRow.label !== "Read") {
					break;
				}
				groupedRows.push(nextRow);
				index++;
			}
			if (groupedRows.length > 1) {
				renderRows.push({
					kind: "html",
					key: `grouped-read-${index}`,
					html: renderReadGroupTimelineRow(groupedRows),
				});
				continue;
			}
		}
		renderRows.push({
			kind: "html",
			key: `tool-${index}`,
			html: renderToolTimelineRow(row),
		});
	}

	return renderRows;
};
