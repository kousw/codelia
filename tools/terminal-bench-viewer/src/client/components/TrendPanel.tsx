import { useState } from "react";
import type { JobSummary } from "../../shared/types";

interface TrendPanelProps {
	jobs: JobSummary[];
	search: string;
	modelFilter: string;
	includePartial: boolean;
	onToggleIncludePartial: () => void;
}

interface TrendPoint {
	jobId: string;
	label: string;
	startedAt: string | null;
	meanReward: number;
	meanExecutionSec: number;
	status: "completed" | "partial";
}

type TrendWindowMode = "all" | "jobs" | "days";

const chartWidth = 760;
const chartHeight = 160;
const chartPadding = 18;

const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatSeconds = (value: number) => `${Math.round(value)}s`;

const formatStartedAt = (value: string | null) => {
	if (!value) return "unknown";
	return value.replace("T", " ").slice(0, 16);
};

const buildLinePoints = (values: number[], maxValue: number) => {
	if (values.length === 0 || maxValue <= 0) return "";
	const usableHeight = chartHeight - chartPadding * 2;
	const usableWidth = chartWidth - chartPadding * 2;
	return values
		.map((value, index) => {
			const x =
				chartPadding +
				(values.length === 1 ? usableWidth / 2 : (usableWidth * index) / (values.length - 1));
			const y =
				chartHeight -
				chartPadding -
				(value / maxValue) * usableHeight;
			return `${x},${y}`;
		})
		.join(" ");
};

const renderTicks = (maxValue: number, formatter: (value: number) => string) => {
	const steps = 4;
	return Array.from({ length: steps + 1 }, (_, index) => {
		const ratio = index / steps;
		const value = maxValue * (1 - ratio);
		const y = chartPadding + (chartHeight - chartPadding * 2) * ratio;
		return (
			<g key={`${maxValue}-${index}`}>
				<line
					x1={chartPadding}
					x2={chartWidth - chartPadding}
					y1={y}
					y2={y}
					className="tbv-chart-grid-line"
				/>
				<text x={0} y={y + 4} className="tbv-chart-tick">
					{formatter(value)}
				</text>
			</g>
		);
	});
};

const buildTrendPoints = (
	jobs: JobSummary[],
	search: string,
	modelFilter: string,
	includePartial: boolean,
) => {
	const normalizedSearch = search.trim().toLowerCase();
	return jobs
		.filter((job) => {
			if (job.status === "unreadable") return false;
			if (!includePartial && job.status !== "completed") return false;
			if (job.meanReward === null || job.meanExecutionSec === null) return false;
			if (modelFilter && job.modelName !== modelFilter) return false;
			if (normalizedSearch.length === 0) return true;
			const haystack = [
				job.jobId,
				job.jobName,
				job.modelName ?? "",
				job.datasetLabel ?? "",
			]
				.join(" ")
				.toLowerCase();
			return haystack.includes(normalizedSearch);
		})
		.sort((left, right) => {
			const leftKey = left.startedAt ?? left.jobId;
			const rightKey = right.startedAt ?? right.jobId;
			return leftKey.localeCompare(rightKey);
		})
		.map(
			(job): TrendPoint => ({
				jobId: job.jobId,
				label: formatStartedAt(job.startedAt),
				startedAt: job.startedAt,
				meanReward: job.meanReward ?? 0,
				meanExecutionSec: job.meanExecutionSec ?? 0,
				status: job.status === "partial" ? "partial" : "completed",
			}),
		);
};

const applyWindowFilter = (
	points: TrendPoint[],
	windowMode: TrendWindowMode,
	windowValue: number,
) => {
	if (windowMode === "all") return points;
	if (windowMode === "jobs") {
		return points.slice(-windowValue);
	}
	const cutoffMs = Date.now() - windowValue * 24 * 60 * 60 * 1000;
	return points.filter((point) => {
		if (!point.startedAt) return false;
		const startedAtMs = Date.parse(point.startedAt);
		return Number.isFinite(startedAtMs) && startedAtMs >= cutoffMs;
	});
};

const TrendChart = ({
	title,
	subtitle,
	points,
	valueSelector,
	maxValue,
	valueFormatter,
	className,
}: {
	title: string;
	subtitle: string;
	points: TrendPoint[];
	valueSelector: (point: TrendPoint) => number;
	maxValue: number;
	valueFormatter: (value: number) => string;
	className: string;
}) => {
	const [hoveredJobId, setHoveredJobId] = useState<string | null>(null);
	const values = points.map(valueSelector);
	const linePoints = buildLinePoints(values, maxValue);
	const pointCoordinates = points.map((point, index) => {
		const x =
			chartPadding +
			(points.length === 1
				? (chartWidth - chartPadding * 2) / 2
				: ((chartWidth - chartPadding * 2) * index) / (points.length - 1));
		const y =
			chartHeight -
			chartPadding -
			(valueSelector(point) / maxValue) * (chartHeight - chartPadding * 2);
		return { point, x, y, value: valueSelector(point) };
	});
	const hoveredPoint =
		hoveredJobId === null
			? null
			: pointCoordinates.find((entry) => entry.point.jobId === hoveredJobId) ?? null;

	return (
		<article className="tbv-chart-card">
			<div className="tbv-chart-header">
				<div>
					<h3>{title}</h3>
					<p>{subtitle}</p>
				</div>
				<strong>{values.length} jobs</strong>
			</div>
			{points.length === 0 ? (
				<p className="tbv-muted">No jobs match the current trend filter.</p>
			) : (
				<>
					<div className="tbv-chart-shell">
						<svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="tbv-chart">
						{renderTicks(maxValue, valueFormatter)}
						<polyline points={linePoints} className={`tbv-chart-line ${className}`} />
						{hoveredPoint ? (
							<line
								x1={hoveredPoint.x}
								x2={hoveredPoint.x}
								y1={chartPadding}
								y2={chartHeight - chartPadding}
								className="tbv-chart-focus-line"
							/>
						) : null}
						{pointCoordinates.map(({ point, x, y, value }) => {
							return (
								<g key={`${title}-${point.jobId}`}>
									<circle
										cx={x}
										cy={y}
										r={4}
										className={`tbv-chart-point ${point.status === "partial" ? "is-partial" : ""}`}
									/>
									<circle
										cx={x}
										cy={y}
										r={11}
										className="tbv-chart-hit"
										onMouseEnter={() => setHoveredJobId(point.jobId)}
										onMouseLeave={() => setHoveredJobId((current) =>
											current === point.jobId ? null : current,
										)}
									/>
								</g>
							);
						})}
						</svg>
						{hoveredPoint ? (
							<div
								className="tbv-chart-tooltip"
								style={{
									left: `${(hoveredPoint.x / chartWidth) * 100}%`,
									top: `${(hoveredPoint.y / chartHeight) * 100}%`,
								}}
							>
								<strong>{valueFormatter(hoveredPoint.value)}</strong>
								<span>{hoveredPoint.point.jobId}</span>
								<span>{hoveredPoint.point.label}</span>
							</div>
						) : null}
					</div>
					<div className="tbv-chart-footer">
						<span>{points[0]?.label}</span>
						<span>{points.at(-1)?.label}</span>
					</div>
				</>
			)}
		</article>
	);
};

export const TrendPanel = ({
	jobs,
	search,
	modelFilter,
	includePartial,
	onToggleIncludePartial,
}: TrendPanelProps) => {
	const [windowMode, setWindowMode] = useState<TrendWindowMode>("all");
	const [windowValue, setWindowValue] = useState(14);
	const allPoints = buildTrendPoints(jobs, search, modelFilter, includePartial);
	const points = applyWindowFilter(allPoints, windowMode, windowValue);
	const rewardMax = 1;
	const executionMax = Math.max(
		60,
		...points.map((point) => point.meanExecutionSec),
	);

	return (
		<section className="tbv-panel">
			<div className="tbv-panel-header">
				<div>
					<p className="tbv-eyebrow">Trend</p>
					<h2>Overall job trend</h2>
				</div>
				<button type="button" className="tbv-pill is-active" onClick={onToggleIncludePartial}>
					{includePartial ? "Including partial jobs" : "Completed jobs only"}
				</button>
			</div>
			<div className="tbv-control-row">
				<label className="tbv-inline-input">
					<span>Range</span>
					<select
						value={windowMode}
						onChange={(event) =>
							setWindowMode(event.target.value as TrendWindowMode)
						}
					>
						<option value="all">All jobs</option>
						<option value="jobs">Recent jobs</option>
						<option value="days">Recent days</option>
					</select>
				</label>
				{windowMode !== "all" ? (
					<label className="tbv-inline-input">
						<span>{windowMode === "jobs" ? "Jobs" : "Days"}</span>
						<input
							type="number"
							min={1}
							step={1}
							value={String(windowValue)}
							onChange={(event) => {
								const nextValue = Number(event.target.value);
								if (Number.isFinite(nextValue) && nextValue > 0) {
									setWindowValue(Math.trunc(nextValue));
								}
							}}
						/>
					</label>
				) : null}
				<div className="tbv-trend-summary">
					<span>{points.length} visible jobs</span>
					<span>
						{windowMode === "all"
							? "full history"
							: windowMode === "jobs"
								? `last ${windowValue} jobs`
								: `last ${windowValue} days`}
					</span>
				</div>
			</div>
			<div className="tbv-chart-grid">
				<TrendChart
					title="Success rate trend"
					subtitle="Mean reward per job over time"
					points={points}
					valueSelector={(point) => point.meanReward}
					maxValue={rewardMax}
					valueFormatter={formatPercent}
					className="is-reward"
				/>
				<TrendChart
					title="Avg execution trend"
					subtitle="Mean task execution seconds per job"
					points={points}
					valueSelector={(point) => point.meanExecutionSec}
					maxValue={executionMax}
					valueFormatter={formatSeconds}
					className="is-duration"
				/>
			</div>
		</section>
	);
};
