import { Electroview } from "electrobun/view";
import {
	type GeneratedUiDocument,
	isGeneratedUiDocument,
} from "../../../protocol/src/index";
import type { DesktopRpcSchema, UiResponsePayload } from "../shared/rpc";
import type {
	ChatMessage,
	DesktopSnapshot,
	DesktopWorkspace,
	InspectBundle,
	StreamEvent,
	StreamUiRequest,
} from "../shared/types";

export type ViewState = {
	snapshot: DesktopSnapshot;
	inspect: InspectBundle | null;
	inspectOpen: boolean;
	composer: string;
	activeRunId: string | null;
	activeSteps: Array<{
		step_id: string;
		step_number: number;
		title: string;
	}>;
	isStreaming: boolean;
	statusLine: string;
	errorMessage: string | null;
	pendingUiRequest: StreamUiRequest | null;
	pendingLocalDialog: {
		kind: "hide-session";
		sessionId: string;
		sessionTitle: string;
	} | null;
	modalText: string;
	modalPickIds: string[];
};

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

const emptySnapshot: DesktopSnapshot = {
	workspaces: [],
	sessions: [],
	transcript: [],
};

const createInitialState = (): ViewState => ({
	snapshot: emptySnapshot,
	inspect: null,
	inspectOpen: false,
	composer: "",
	activeRunId: null,
	activeSteps: [],
	isStreaming: false,
	statusLine: "Idle",
	errorMessage: null,
	pendingUiRequest: null,
	pendingLocalDialog: null,
	modalText: "",
	modalPickIds: [],
});

const createMessageId = (() => {
	let next = 0;
	return () => `view-msg-${++next}-${Date.now()}`;
})();

let currentState = createInitialState();
const listeners = new Set<() => void>();

export const subscribeDesktopViewState = (
	listener: () => void,
): (() => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const getDesktopViewStateSnapshot = (): ViewState => currentState;

export const selectedWorkspace = (
	snapshot: DesktopSnapshot,
): DesktopWorkspace | undefined =>
	snapshot.workspaces.find(
		(workspace) => workspace.path === snapshot.selected_workspace_path,
	);

const syncDocumentTitle = (state: ViewState): void => {
	const workspace = selectedWorkspace(state.snapshot);
	document.title = workspace
		? `Codelia Desktop · ${workspace.name}`
		: "Codelia Desktop";
};

export const commitState = (recipe: (draft: ViewState) => void): ViewState => {
	const next = structuredClone(currentState) as ViewState;
	recipe(next);
	currentState = next;
	syncDocumentTitle(next);
	for (const listener of listeners) {
		listener();
	}
	return next;
};

const hydrateSnapshotDraft = (
	draft: ViewState,
	snapshot: DesktopSnapshot,
): void => {
	draft.snapshot = snapshot;
	draft.activeSteps = [];
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

const firstMeaningfulLine = (value: string): string => {
	return (
		value
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? ""
	);
};

const formatDurationMs = (value: number): string => {
	if (value >= 10_000) {
		return `${Math.round(value / 1000)}s`;
	}
	if (value >= 1_000) {
		return `${(value / 1000).toFixed(1)}s`;
	}
	return `${value}ms`;
};

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

const describeActiveSteps = (state: ViewState): string => {
	if (state.activeSteps.length === 0) {
		return state.isStreaming ? "Running" : "Idle";
	}
	const latest = state.activeSteps[state.activeSteps.length - 1];
	const current = `Step ${latest.step_number}: ${latest.title}`;
	return state.activeSteps.length === 1
		? current
		: `${current} (+${state.activeSteps.length - 1} more)`;
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
		if (event.type === "step_start") {
			rows.push({
				kind: "html",
				html: renderTimelineNote(
					`Step ${event.step_number}`,
					event.title,
					"default",
				),
			});
			continue;
		}
		if (event.type === "step_complete") {
			rows.push({
				kind: "html",
				html: renderTimelineNote(
					event.status === "error" ? "Step failed" : "Step completed",
					formatDurationMs(event.duration_ms),
					event.status === "error" ? "error" : "default",
				),
			});
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

const appendAssistantEvent = (
	messages: ChatMessage[],
	event: StreamEvent,
): ChatMessage[] => {
	if (
		event.kind !== "agent.event" ||
		event.event.type === "hidden_user_message"
	) {
		return messages;
	}
	const next = [...messages];
	let assistant = next[next.length - 1];
	if (!assistant || assistant.role !== "assistant") {
		assistant = {
			id: createMessageId(),
			role: "assistant",
			content: "",
			events: [],
			timestamp: Date.now(),
		};
		next.push(assistant);
	}
	const updated = {
		...assistant,
		events: [...assistant.events, event.event],
	};
	if (event.event.type === "text") {
		updated.content += event.event.content;
	}
	if (event.event.type === "final") {
		updated.content = event.event.content;
	}
	next[next.length - 1] = updated;
	return next;
};

const rpc = Electroview.defineRPC<DesktopRpcSchema>({
	maxRequestTime: 5 * 60 * 1000,
	handlers: {
		messages: {
			runEvent: (event) => {
				void handleRunEvent(event);
			},
			menuAction: (payload) => {
				commitState((draft) => {
					if (payload.snapshot) {
						hydrateSnapshotDraft(draft, payload.snapshot);
					}
					if (payload.action === "new-chat") {
						draft.snapshot.selected_session_id = undefined;
						draft.snapshot.transcript = [];
						draft.activeRunId = null;
						draft.activeSteps = [];
						draft.isStreaming = false;
						draft.inspectOpen = false;
						draft.statusLine = "Draft";
					}
				});
			},
			toast: (payload) => {
				commitState((draft) => {
					draft.errorMessage = payload.message;
				});
			},
		},
	},
});

new Electroview({ rpc });

const refreshCurrentSnapshot = async (): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) {
		return;
	}
	const snapshot = await rpc.request.loadSession({
		workspace_path: workspacePath,
		session_id: currentState.snapshot.selected_session_id ?? null,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
	});
};

const handleRunEvent = async (event: StreamEvent): Promise<void> => {
	if (event.kind === "agent.event") {
		commitState((draft) => {
			const agentEvent = event.event;
			if (agentEvent.type === "step_start") {
				draft.activeSteps = [
					...draft.activeSteps.filter(
						(step) => step.step_id !== agentEvent.step_id,
					),
					{
						step_id: agentEvent.step_id,
						step_number: agentEvent.step_number,
						title: agentEvent.title,
					},
				];
				draft.statusLine = describeActiveSteps(draft);
			} else if (agentEvent.type === "step_complete") {
				const completed = draft.activeSteps.find(
					(step) => step.step_id === agentEvent.step_id,
				);
				draft.activeSteps = draft.activeSteps.filter(
					(step) => step.step_id !== agentEvent.step_id,
				);
				draft.statusLine =
					agentEvent.status === "error"
						? `${completed ? `Step ${completed.step_number}: ${completed.title}` : "Step"} failed in ${formatDurationMs(
								agentEvent.duration_ms,
							)}`
						: describeActiveSteps(draft);
			} else if (agentEvent.type === "compaction_start") {
				draft.statusLine = "Compaction running";
			} else if (agentEvent.type === "compaction_complete") {
				draft.statusLine = agentEvent.compacted
					? "Compaction completed"
					: "Compaction skipped";
			}
			draft.snapshot.transcript = appendAssistantEvent(
				draft.snapshot.transcript,
				event,
			);
		});
		return;
	}

	if (event.kind === "run.status") {
		commitState((draft) => {
			draft.statusLine =
				event.status === "error" && event.message
					? `Error: ${event.message}`
					: event.status === "running" && draft.activeSteps.length > 0
						? describeActiveSteps(draft)
						: event.status;
			if (event.status === "error") {
				draft.isStreaming = false;
				draft.activeRunId = null;
				draft.activeSteps = [];
				draft.errorMessage = event.message ?? "Run failed";
				return;
			}
			if (event.status !== "running") {
				draft.errorMessage = null;
			}
			if (event.status === "completed" || event.status === "cancelled") {
				draft.isStreaming = false;
				draft.activeRunId = null;
				draft.activeSteps = [];
			}
		});
		if (event.status === "completed" || event.status === "cancelled") {
			await refreshCurrentSnapshot();
		}
		return;
	}

	if (event.kind === "run.context") {
		commitState((draft) => {
			draft.statusLine =
				draft.activeSteps.length > 0
					? `${describeActiveSteps(draft)} · context ${event.context_left_percent}% left`
					: `Context ${event.context_left_percent}% left`;
		});
		return;
	}

	if (event.kind === "ui.request") {
		commitState((draft) => {
			draft.pendingUiRequest = event;
			draft.modalText =
				event.method === "ui.prompt.request" &&
				"default_value" in event.params &&
				event.params.default_value
					? event.params.default_value
					: "";
			draft.modalPickIds = [];
			draft.statusLine = "Waiting for input";
		});
		return;
	}

	if (event.kind === "done") {
		commitState((draft) => {
			draft.isStreaming = false;
			draft.activeRunId = null;
			draft.activeSteps = [];
		});
		await refreshCurrentSnapshot();
	}
};

let initializePromise: Promise<void> | null = null;

export const initializeView = async (): Promise<void> => {
	if (!initializePromise) {
		initializePromise = (async () => {
			const snapshot = await rpc.request.initialize();
			commitState((draft) => {
				hydrateSnapshotDraft(draft, snapshot);
			});
		})().catch((error) => {
			initializePromise = null;
			commitState((draft) => {
				draft.errorMessage = String(error);
				draft.statusLine = "Error";
			});
		});
	}
	await initializePromise;
};

export const openWorkspaceDialog = async (): Promise<void> => {
	try {
		const snapshot = await rpc.request.openWorkspaceDialog();
		commitState((draft) => {
			hydrateSnapshotDraft(draft, snapshot);
			draft.inspect = null;
			draft.inspectOpen = false;
			draft.errorMessage = null;
			draft.statusLine = "Workspace opened";
		});
	} catch (error) {
		commitState((draft) => {
			draft.errorMessage = String(error);
		});
	}
};

export const openWorkspaceForNewChat = async (): Promise<void> => {
	try {
		const openedSnapshot = await rpc.request.openWorkspaceDialog();
		const workspacePath = openedSnapshot.selected_workspace_path;
		if (!workspacePath) {
			commitState((draft) => {
				hydrateSnapshotDraft(draft, openedSnapshot);
				draft.inspect = null;
				draft.inspectOpen = false;
				draft.errorMessage = null;
				draft.statusLine = "Workspace opened";
			});
			return;
		}
		const snapshot = await rpc.request.loadSession({
			workspace_path: workspacePath,
			session_id: null,
		});
		commitState((draft) => {
			hydrateSnapshotDraft(draft, snapshot);
			draft.inspect = null;
			draft.inspectOpen = false;
			draft.errorMessage = null;
			draft.statusLine = "Workspace opened • Draft ready";
		});
	} catch (error) {
		commitState((draft) => {
			draft.errorMessage = String(error);
		});
	}
};

export const loadWorkspace = async (workspacePath: string): Promise<void> => {
	const snapshot = await rpc.request.loadWorkspace({
		workspace_path: workspacePath,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
		draft.inspect = null;
		draft.inspectOpen = false;
		draft.errorMessage = null;
		draft.statusLine = "Workspace ready";
	});
};

export const loadSession = async (sessionId: string | null): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const snapshot = await rpc.request.loadSession({
		workspace_path: workspacePath,
		session_id: sessionId,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
		draft.statusLine = sessionId ? "Session loaded" : "Draft";
	});
};

export const renameSession = async (sessionId: string): Promise<void> => {
	const session = currentState.snapshot.sessions.find(
		(entry) => entry.session_id === sessionId,
	);
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!session || !workspacePath) return;
	const nextTitle = window.prompt("Session title", session.title);
	if (nextTitle === null) return;
	const snapshot = await rpc.request.updateSession({
		session_id: sessionId,
		workspace_path: workspacePath,
		title: nextTitle,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
	});
};

export const requestHideSession = (sessionId: string): void => {
	if (currentState.pendingUiRequest) return;
	const session = currentState.snapshot.sessions.find(
		(entry) => entry.session_id === sessionId,
	);
	if (!session) return;
	commitState((draft) => {
		draft.pendingLocalDialog = {
			kind: "hide-session",
			sessionId,
			sessionTitle: session.title,
		};
	});
};

export const hideSession = async (sessionId: string): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const snapshot = await rpc.request.updateSession({
		session_id: sessionId,
		workspace_path: workspacePath,
		archived: true,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
		draft.pendingLocalDialog = null;
		draft.statusLine = "Session hidden";
	});
};

export const loadInspect = async (): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) return;
	if (currentState.inspectOpen) {
		commitState((draft) => {
			draft.inspectOpen = false;
		});
		return;
	}
	commitState((draft) => {
		draft.inspectOpen = true;
	});
	const inspect = await rpc.request.getInspect({
		workspace_path: workspacePath,
	});
	commitState((draft) => {
		draft.inspect = inspect;
		draft.inspectOpen = true;
	});
};

export const openWorkspaceTarget = async (
	target: "cursor" | "finder",
): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const result = await rpc.request.openWorkspaceTarget({
		workspace_path: workspacePath,
		target,
	});
	if (!result.ok) {
		commitState((draft) => {
			draft.errorMessage = result.message ?? "Failed to open workspace";
		});
	}
};

export const openTranscriptLink = async (href: string): Promise<void> => {
	const result = await rpc.request.openLink({
		href,
		workspace_path: currentState.snapshot.selected_workspace_path,
	});
	if (!result.ok) {
		commitState((draft) => {
			draft.errorMessage = result.message ?? "Failed to open link";
		});
	}
};

export const refreshInspect = async (): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	if (!workspacePath) return;
	const inspect = await rpc.request.getInspect({
		workspace_path: workspacePath,
	});
	commitState((draft) => {
		draft.inspect = inspect;
		draft.inspectOpen = true;
	});
};

export const sendPrompt = async (): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const message = currentState.composer.trim();
	if (!workspacePath || message.length === 0 || currentState.isStreaming) {
		return;
	}

	commitState((draft) => {
		draft.errorMessage = null;
		draft.composer = "";
		draft.isStreaming = true;
		draft.activeSteps = [];
		draft.statusLine = "Starting";
		draft.snapshot.transcript = [
			...draft.snapshot.transcript,
			{
				id: createMessageId(),
				role: "user",
				content: message,
				events: [],
				timestamp: Date.now(),
			},
			{
				id: createMessageId(),
				role: "assistant",
				content: "",
				events: [],
				timestamp: Date.now() + 1,
			},
		];
	});

	try {
		const started = await rpc.request.startRun({
			workspace_path: workspacePath,
			session_id: currentState.snapshot.selected_session_id,
			message,
		});
		commitState((draft) => {
			draft.activeRunId = started.run_id;
			if (started.session_id) {
				draft.snapshot.selected_session_id = started.session_id;
			}
		});
	} catch (error) {
		commitState((draft) => {
			draft.isStreaming = false;
			draft.activeSteps = [];
			draft.errorMessage = String(error);
			draft.statusLine = "Error";
			if (
				draft.snapshot.transcript.at(-1)?.role === "assistant" &&
				draft.snapshot.transcript.at(-1)?.content === "" &&
				draft.snapshot.transcript.at(-1)?.events.length === 0
			) {
				draft.snapshot.transcript = draft.snapshot.transcript.slice(0, -1);
			}
		});
	}
};

export const cancelRun = async (): Promise<void> => {
	if (!currentState.activeRunId) return;
	await rpc.request.cancelRun({ run_id: currentState.activeRunId });
};

export const submitModal = async (result: UiResponsePayload): Promise<void> => {
	if (!currentState.pendingUiRequest) return;
	await rpc.request.respondUiRequest({
		request_id: currentState.pendingUiRequest.request_id,
		result,
	});
	commitState((draft) => {
		draft.pendingUiRequest = null;
		draft.modalText = "";
		draft.modalPickIds = [];
		draft.statusLine = "Continuing";
	});
};

export const updateModel = async (name: string): Promise<void> => {
	const workspacePath = currentState.snapshot.selected_workspace_path;
	const model = currentState.snapshot.runtime_health?.model;
	if (!workspacePath || !name || !model) return;
	const snapshot = await rpc.request.setModel({
		workspace_path: workspacePath,
		name,
		provider: model.provider,
		reasoning: model.reasoning,
	});
	commitState((draft) => {
		hydrateSnapshotDraft(draft, snapshot);
		draft.statusLine = "Model updated";
	});
};

export const resolveModalDismissPayload = (
	request: StreamUiRequest,
): UiResponsePayload => {
	if (request.method === "ui.confirm.request") {
		return { ok: false };
	}
	if (request.method === "ui.prompt.request") {
		return { value: null };
	}
	return { ids: [] };
};
