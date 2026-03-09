import type { JobDetail, TaskResultRow } from "../../shared/types";

interface TaskCompareRow {
	taskName: string;
	primary: TaskResultRow | null;
	compare: TaskResultRow | null;
	changed: boolean;
}

interface TaskTableProps {
	primary: JobDetail | null;
	compare: JobDetail | null;
	selectedTaskName: string | null;
	taskSearch: string;
	onTaskSearchChange: (value: string) => void;
	onSelectTask: (taskName: string) => void;
}

const formatReward = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(0)}%`;

const formatSeconds = (value: number | null) => (value === null ? "—" : `${value}s`);

const buildRows = (
	primary: JobDetail | null,
	compare: JobDetail | null,
	search: string,
) => {
	if (!primary) return [] as TaskCompareRow[];

	const rows = new Map<string, TaskCompareRow>();
	for (const task of primary.tasks) {
		rows.set(task.taskName, {
			taskName: task.taskName,
			primary: task,
			compare: null,
			changed: false,
		});
	}
	for (const task of compare?.tasks ?? []) {
		const existing = rows.get(task.taskName);
		if (existing) {
			existing.compare = task;
			existing.changed = existing.primary?.success !== task.success;
		} else {
			rows.set(task.taskName, {
				taskName: task.taskName,
				primary: null,
				compare: task,
				changed: true,
			});
		}
	}

	const normalizedSearch = search.trim().toLowerCase();
	return [...rows.values()]
		.filter((row) =>
			normalizedSearch.length === 0
				? true
				: row.taskName.toLowerCase().includes(normalizedSearch),
		)
		.sort((left, right) => {
			if (left.changed !== right.changed) {
				return left.changed ? -1 : 1;
			}
			const leftReward = left.primary?.reward ?? -1;
			const rightReward = right.primary?.reward ?? -1;
			if (leftReward !== rightReward) {
				return leftReward - rightReward;
			}
			return left.taskName.localeCompare(right.taskName);
		});
};

const statusClass = (task: TaskResultRow | null) =>
	task === null ? "status-missing" : task.success ? "status-success" : "status-failed";

export const TaskTable = ({
	primary,
	compare,
	selectedTaskName,
	taskSearch,
	onTaskSearchChange,
	onSelectTask,
}: TaskTableProps) => {
	const rows = buildRows(primary, compare, taskSearch);

	return (
		<section className="tbv-panel">
			<div className="tbv-panel-header">
				<div>
					<p className="tbv-eyebrow">Tasks</p>
					<h2>{compare ? "Job diff" : "Primary job details"}</h2>
				</div>
				<label className="tbv-inline-input">
					<span>Task search</span>
					<input
						value={taskSearch}
						onChange={(event) => onTaskSearchChange(event.target.value)}
						placeholder="filter by task name"
					/>
				</label>
			</div>
			<div className="tbv-table-wrap">
				<table className="tbv-table">
					<thead>
						<tr>
							<th>Task</th>
							<th>Primary</th>
							<th>Primary total</th>
							{compare ? <th>Compare</th> : null}
							{compare ? <th>Compare total</th> : null}
							<th>Exception</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr
								key={row.taskName}
								className={`${selectedTaskName === row.taskName ? "is-selected" : ""}${
									row.changed ? " is-changed" : ""
								}`}
								onClick={() => onSelectTask(row.taskName)}
							>
								<td>{row.taskName}</td>
								<td className={statusClass(row.primary)}>
									{formatReward(row.primary?.reward ?? null)}
								</td>
								<td>{formatSeconds(row.primary?.totalSec ?? null)}</td>
								{compare ? (
									<td className={statusClass(row.compare)}>
										{formatReward(row.compare?.reward ?? null)}
									</td>
								) : null}
								{compare ? (
									<td>{formatSeconds(row.compare?.totalSec ?? null)}</td>
								) : null}
								<td>{row.primary?.exceptionType ?? row.compare?.exceptionType ?? "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	);
};
