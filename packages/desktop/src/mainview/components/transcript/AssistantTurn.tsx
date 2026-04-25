import {
	type AssistantRenderRow,
	summarizeGroupedStatus,
	summarizeReadGroup,
	type ToolTimelineRow,
} from "../../controller/transcript";
import { GeneratedUiPanel } from "../GeneratedUiPanel";
import { AssistantMarkdown } from "./AssistantMarkdown";

const stateLabelForStatus = (
	status: ToolTimelineRow["status"],
): "running" | "done" | "error" =>
	status === "error" ? "error" : status === "completed" ? "done" : "running";

const statusText = (status: ToolTimelineRow["status"]): string =>
	status === "error" ? "Error" : status === "completed" ? "Done" : "Running";

const DetailSection = ({
	label,
	body,
	scrollable,
	onCopySection,
}: {
	label: string;
	body: string;
	scrollable?: boolean;
	onCopySection: (text: string) => void;
}) => (
	<section
		className={`timeline-detail-section${scrollable ? " is-scrollable" : ""}`}
	>
		<div className="timeline-detail-head">
			<div className="timeline-detail-label">{label}</div>
			<button
				type="button"
				className="copy-chip"
				onClick={() => onCopySection(body)}
			>
				Copy
			</button>
		</div>
		<pre>{body}</pre>
	</section>
);

const ToolDetails = ({
	row,
	onCopySection,
}: {
	row: ToolTimelineRow;
	onCopySection: (text: string) => void;
}) => {
	const permissionText = [row.permissionSummary, row.permissionDiff]
		.filter((value): value is string => Boolean(value))
		.join("\n\n");
	const hasDetails = Boolean(permissionText || row.resultText);
	if (!hasDetails) {
		return null;
	}
	return (
		<div className="timeline-detail">
			{permissionText ? (
				<DetailSection
					label="Permission"
					body={permissionText}
					onCopySection={onCopySection}
				/>
			) : null}
			{row.resultText ? (
				<DetailSection
					label={row.status === "error" ? "Result (error)" : "Result"}
					body={row.resultText}
					scrollable
					onCopySection={onCopySection}
				/>
			) : null}
		</div>
	);
};

const ToolRow = ({
	row,
	onCopySection,
}: {
	row: ToolTimelineRow;
	onCopySection: (text: string) => void;
}) => {
	const stateLabel = stateLabelForStatus(row.status);
	return (
		<details className={`timeline-item timeline-tool is-${stateLabel}`}>
			<summary>
				<span className="timeline-label">{row.label}</span>
				<span className="timeline-summary">{row.summary}</span>
				<span className={`timeline-state is-${stateLabel}`}>
					{statusText(row.status)}
				</span>
			</summary>
			<ToolDetails row={row} onCopySection={onCopySection} />
		</details>
	);
};

const NestedToolRow = ({
	row,
	onCopySection,
}: {
	row: ToolTimelineRow;
	onCopySection: (text: string) => void;
}) => {
	const stateLabel = stateLabelForStatus(row.status);
	return (
		<details className={`timeline-subitem is-${stateLabel}`}>
			<summary>
				<span className={`timeline-substate is-${stateLabel}`} />
				<span className="timeline-subsummary">{row.summary}</span>
			</summary>
			<div className="timeline-subdetail">
				<ToolDetails row={row} onCopySection={onCopySection} />
			</div>
		</details>
	);
};

const ReadGroupRow = ({
	rows,
	onCopySection,
}: {
	rows: ToolTimelineRow[];
	onCopySection: (text: string) => void;
}) => {
	const stateLabel = summarizeGroupedStatus(rows);
	return (
		<details className={`timeline-item timeline-tool is-${stateLabel}`}>
			<summary>
				<span className="timeline-label">Read</span>
				<span className="timeline-summary">{summarizeReadGroup(rows)}</span>
				<span className={`timeline-state is-${stateLabel}`} />
			</summary>
			<div className="timeline-detail">
				<div className="timeline-substack">
					{rows.map((row) => (
						<NestedToolRow
							key={row.toolCallId}
							row={row}
							onCopySection={onCopySection}
						/>
					))}
				</div>
			</div>
		</details>
	);
};

const ReasoningRow = ({
	summary,
	content,
	onCopySection,
}: {
	summary: string;
	content: string;
	onCopySection: (text: string) => void;
}) => (
	<details className="timeline-item">
		<summary>
			<span className="timeline-label">Reasoning</span>
			<span className="timeline-summary">{summary}</span>
		</summary>
		<div className="timeline-detail">
			<DetailSection
				label="Trace"
				body={content}
				onCopySection={onCopySection}
			/>
		</div>
	</details>
);

const NoteRow = ({
	label,
	summary,
	tone,
}: {
	label: string;
	summary?: string;
	tone: "default" | "warning" | "error";
}) => (
	<div className={`timeline-note${tone !== "default" ? ` is-${tone}` : ""}`}>
		<span className="timeline-note-label">{label}</span>
		{summary ? <span className="timeline-note-summary">{summary}</span> : null}
	</div>
);

export const AssistantTurn = ({
	rows,
	onOpenLink,
	onCopySection,
}: {
	rows: AssistantRenderRow[];
	onOpenLink: (href: string) => Promise<void>;
	onCopySection: (text: string) => void;
}) => {
	return (
		<article className="assistant-turn">
			<div className="assistant-heading">
				<strong className="bubble-author">Codelia</strong>
			</div>
			<div className="timeline-stack">
				{rows.map((row) =>
					row.kind === "generated_ui" ? (
						<GeneratedUiPanel key={row.key} payload={row.payload} />
					) : row.kind === "tool" ? (
						<ToolRow
							key={row.key}
							row={row.row}
							onCopySection={onCopySection}
						/>
					) : row.kind === "read_group" ? (
						<ReadGroupRow
							key={row.key}
							rows={row.rows}
							onCopySection={onCopySection}
						/>
					) : row.kind === "reasoning" ? (
						<ReasoningRow
							key={row.key}
							summary={row.summary}
							content={row.content}
							onCopySection={onCopySection}
						/>
					) : row.kind === "note" ? (
						<NoteRow
							key={row.key}
							label={row.label}
							summary={row.summary}
							tone={row.tone}
						/>
					) : (
						<AssistantMarkdown
							key={row.key}
							content={row.content}
							finalized={row.finalized}
							onOpenLink={onOpenLink}
						/>
					),
				)}
			</div>
		</article>
	);
};
