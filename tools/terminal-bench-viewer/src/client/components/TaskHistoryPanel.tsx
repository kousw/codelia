import type { TaskHistoryPoint } from "../../shared/types";

interface TaskHistoryPanelProps {
	taskName: string | null;
	history: TaskHistoryPoint[];
	loading: boolean;
	error: string | null;
	includePartial: boolean;
	onToggleIncludePartial: () => void;
	highlightedJobIds: string[];
}

const formatReward = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(0)}%`;

const formatSeconds = (value: number | null) =>
	value === null ? "—" : `${value}s`;

export const TaskHistoryPanel = ({
	taskName,
	history,
	loading,
	error,
	includePartial,
	onToggleIncludePartial,
	highlightedJobIds,
}: TaskHistoryPanelProps) => (
	<section className="tbv-panel">
		<div className="tbv-panel-header">
			<div>
				<p className="tbv-eyebrow">History</p>
				<h2>{taskName ?? "Select a task row"}</h2>
			</div>
			<button
				type="button"
				className="tbv-pill is-active"
				onClick={onToggleIncludePartial}
			>
				{includePartial ? "Including partial jobs" : "Completed jobs only"}
			</button>
		</div>
		{loading ? <p className="tbv-muted">Loading task history…</p> : null}
		{error ? <p className="tbv-error">{error}</p> : null}
		{!loading && !error && taskName && history.length === 0 ? (
			<p className="tbv-muted">No history rows matched the current filter.</p>
		) : null}
		<div className="tbv-history-list">
			{history.map((entry) => (
				<article
					key={`${entry.jobId}-${taskName ?? "task"}`}
					className={`tbv-history-card${
						highlightedJobIds.includes(entry.jobId) ? " is-highlighted" : ""
					}`}
				>
					<div className="tbv-history-header">
						<strong>{entry.jobId}</strong>
						<span>{entry.jobStatus}</span>
					</div>
					<div className="tbv-history-meta">
						<span>{entry.modelName ?? "unknown model"}</span>
						<span>{formatReward(entry.reward)}</span>
						<span>{formatSeconds(entry.totalSec)}</span>
					</div>
					<div className="tbv-history-bar">
						<div
							className={`tbv-history-fill${
								entry.success ? " is-success" : " is-failed"
							}`}
							style={{
								width: `${Math.min(
									100,
									Math.max(6, ((entry.totalSec ?? 0) / 1800) * 100),
								)}%`,
							}}
						/>
					</div>
				</article>
			))}
		</div>
	</section>
);
