import { useState } from "react";
import type { TaskAggregateSummary } from "../../shared/types";

type TaskSortKey =
	| "taskName"
	| "successRate"
	| "windowSuccessRate"
	| "windowSuccessDelta"
	| "meanExecutionSec"
	| "windowMeanExecutionSec"
	| "windowExecutionDeltaSec"
	| "runs"
	| "lastSeenAt";

interface TaskAggregatePanelProps {
	tasks: TaskAggregateSummary[];
	loading: boolean;
	error: string | null;
	search: string;
	onSearchChange: (value: string) => void;
	includePartial: boolean;
	onToggleIncludePartial: () => void;
	modelFilter: string;
	onModelFilterChange: (value: string) => void;
	modelOptions: string[];
	windowMode: "runs" | "days";
	onWindowModeChange: (value: "runs" | "days") => void;
	windowValue: number;
	onWindowValueChange: (value: number) => void;
	selectedTaskName: string | null;
	onSelectTask: (taskName: string) => void;
}

const formatPercent = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(1)}%`;

const formatDeltaPercent = (value: number | null) =>
	value === null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}pt`;

const formatSeconds = (value: number | null) =>
	value === null ? "—" : `${value}s`;

const formatDeltaSeconds = (value: number | null) =>
	value === null ? "—" : `${value > 0 ? "+" : ""}${value}s`;

const compareNullable = (
	left: number | string | null,
	right: number | string | null,
	direction: "asc" | "desc",
) => {
	if (left === right) return 0;
	if (left === null) return 1;
	if (right === null) return -1;
	if (typeof left === "string" && typeof right === "string") {
		return direction === "asc"
			? left.localeCompare(right)
			: right.localeCompare(left);
	}
	return direction === "asc"
		? Number(left) - Number(right)
		: Number(right) - Number(left);
};

export const TaskAggregatePanel = ({
	tasks,
	loading,
	error,
	search,
	onSearchChange,
	includePartial,
	onToggleIncludePartial,
	modelFilter,
	onModelFilterChange,
	modelOptions,
	windowMode,
	onWindowModeChange,
	windowValue,
	onWindowValueChange,
	selectedTaskName,
	onSelectTask,
}: TaskAggregatePanelProps) => {
	const [sortKey, setSortKey] = useState<TaskSortKey>("windowSuccessDelta");
	const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
	const normalizedSearch = search.trim().toLowerCase();
	const filtered = tasks
		.filter((task) =>
			normalizedSearch.length === 0
				? true
				: task.taskName.toLowerCase().includes(normalizedSearch),
		)
		.sort((left, right) => {
			switch (sortKey) {
				case "taskName":
					return compareNullable(left.taskName, right.taskName, sortDirection);
				case "successRate":
					return compareNullable(
						left.successRate,
						right.successRate,
						sortDirection,
					);
				case "windowSuccessRate":
					return compareNullable(
						left.windowSuccessRate,
						right.windowSuccessRate,
						sortDirection,
					);
				case "windowSuccessDelta":
					return compareNullable(
						left.windowSuccessDelta,
						right.windowSuccessDelta,
						sortDirection,
					);
				case "meanExecutionSec":
					return compareNullable(
						left.meanExecutionSec,
						right.meanExecutionSec,
						sortDirection,
					);
				case "windowMeanExecutionSec":
					return compareNullable(
						left.windowMeanExecutionSec,
						right.windowMeanExecutionSec,
						sortDirection,
					);
				case "windowExecutionDeltaSec":
					return compareNullable(
						left.windowExecutionDeltaSec,
						right.windowExecutionDeltaSec,
						sortDirection,
					);
				case "runs":
					return compareNullable(left.runs, right.runs, sortDirection);
				case "lastSeenAt":
					return compareNullable(
						left.lastSeenAt,
						right.lastSeenAt,
						sortDirection,
					);
				default:
					return 0;
			}
		});

	const handleSort = (nextKey: TaskSortKey) => {
		if (sortKey === nextKey) {
			setSortDirection((current) => (current === "desc" ? "asc" : "desc"));
			return;
		}
		setSortKey(nextKey);
		setSortDirection(
			nextKey === "taskName" || nextKey === "lastSeenAt" ? "asc" : "desc",
		);
	};

	const renderSortLabel = (key: TaskSortKey, label: string) => {
		const marker =
			sortKey === key ? (sortDirection === "asc" ? "^" : "v") : "<>";
		return (
			<>
				{label} <span aria-hidden="true">{marker}</span>
			</>
		);
	};

	return (
		<section className="tbv-panel">
			<div className="tbv-panel-header">
				<div>
					<p className="tbv-eyebrow">Task Aggregate</p>
					<h2>Task success rate</h2>
				</div>
				<button
					type="button"
					className="tbv-pill is-active"
					onClick={onToggleIncludePartial}
				>
					{includePartial ? "Including partial jobs" : "Completed jobs only"}
				</button>
			</div>
			<label className="tbv-inline-input">
				<span>Task search</span>
				<input
					value={search}
					onChange={(event) => onSearchChange(event.target.value)}
					placeholder="search task aggregate list"
				/>
			</label>
			<div className="tbv-control-row">
				<label className="tbv-inline-input">
					<span>Model filter</span>
					<select
						value={modelFilter}
						onChange={(event) => onModelFilterChange(event.target.value)}
					>
						<option value="">All models</option>
						{modelOptions.map((modelName) => (
							<option key={modelName} value={modelName}>
								{modelName}
							</option>
						))}
					</select>
				</label>
				<label className="tbv-inline-input">
					<span>Window mode</span>
					<select
						value={windowMode}
						onChange={(event) =>
							onWindowModeChange(event.target.value as "runs" | "days")
						}
					>
						<option value="runs">Recent N runs</option>
						<option value="days">Recent days</option>
					</select>
				</label>
				<label className="tbv-inline-input">
					<span>{windowMode === "runs" ? "Runs" : "Days"}</span>
					<input
						type="number"
						min={1}
						step={1}
						value={String(windowValue)}
						onChange={(event) => {
							const nextValue = Number(event.target.value);
							if (Number.isFinite(nextValue) && nextValue > 0) {
								onWindowValueChange(Math.trunc(nextValue));
							}
						}}
					/>
				</label>
			</div>
			{loading ? <p className="tbv-muted">Loading task aggregates…</p> : null}
			{error ? <p className="tbv-error">{error}</p> : null}
			<div className="tbv-table-wrap">
				<table className="tbv-table">
					<thead>
						<tr>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("taskName")}
								>
									{renderSortLabel("taskName", "Task")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("successRate")}
								>
									{renderSortLabel("successRate", "Success")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("windowSuccessRate")}
								>
									{renderSortLabel(
										"windowSuccessRate",
										tasks[0]?.windowLabel ?? "Window success",
									)}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("windowSuccessDelta")}
								>
									{renderSortLabel("windowSuccessDelta", "Success delta")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("meanExecutionSec")}
								>
									{renderSortLabel("meanExecutionSec", "Avg exec")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("windowMeanExecutionSec")}
								>
									{renderSortLabel("windowMeanExecutionSec", "Window exec")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("windowExecutionDeltaSec")}
								>
									{renderSortLabel("windowExecutionDeltaSec", "Exec delta")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("runs")}
								>
									{renderSortLabel("runs", "Runs")}
								</button>
							</th>
							<th>
								<button
									type="button"
									className="tbv-sort-button"
									onClick={() => handleSort("lastSeenAt")}
								>
									{renderSortLabel("lastSeenAt", "Last seen")}
								</button>
							</th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((task) => (
							<tr
								key={task.taskName}
								className={
									selectedTaskName === task.taskName ? "is-selected" : ""
								}
								onClick={() => onSelectTask(task.taskName)}
							>
								<td>{task.taskName}</td>
								<td
									className={
										(task.successRate ?? 0) >= 0.8
											? "status-success"
											: (task.successRate ?? 0) < 0.3
												? "status-failed"
												: ""
									}
								>
									{formatPercent(task.successRate)}
								</td>
								<td>{formatPercent(task.windowSuccessRate)}</td>
								<td
									className={
										(task.windowSuccessDelta ?? 0) < 0
											? "status-failed"
											: (task.windowSuccessDelta ?? 0) > 0
												? "status-success"
												: ""
									}
								>
									{formatDeltaPercent(task.windowSuccessDelta)}
								</td>
								<td>{formatSeconds(task.meanExecutionSec)}</td>
								<td>{formatSeconds(task.windowMeanExecutionSec)}</td>
								<td
									className={
										(task.windowExecutionDeltaSec ?? 0) > 0
											? "status-failed"
											: (task.windowExecutionDeltaSec ?? 0) < 0
												? "status-success"
												: ""
									}
								>
									{formatDeltaSeconds(task.windowExecutionDeltaSec)}
								</td>
								<td>
									{task.runs}
									{task.partialRuns > 0 ? ` (${task.partialRuns} partial)` : ""}
								</td>
								<td>
									{task.lastSeenAt
										? task.lastSeenAt.replace("T", " ").slice(0, 16)
										: "—"}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
};
