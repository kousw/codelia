import type { JobDetail } from "../../shared/types";

interface JobOverviewProps {
	primary: JobDetail | null;
	compare: JobDetail | null;
}

const formatPercent = (value: number | null) =>
	value === null ? "—" : `${(value * 100).toFixed(1)}%`;

const formatSeconds = (value: number | null) =>
	value === null ? "—" : `${value}s`;

export const JobOverview = ({ primary, compare }: JobOverviewProps) => {
	if (!primary) {
		return (
			<section className="tbv-panel">
				<div className="tbv-panel-header">
					<p className="tbv-eyebrow">Overview</p>
					<h2>Select a primary job</h2>
				</div>
			</section>
		);
	}

	const compareJob = compare?.job ?? null;
	const rewardDelta =
		primary.job.meanReward !== null &&
		compareJob !== null &&
		compareJob.meanReward !== null
			? primary.job.meanReward - compareJob.meanReward
			: null;

	return (
		<section className="tbv-panel">
			<div className="tbv-panel-header">
				<div>
					<p className="tbv-eyebrow">Overview</p>
					<h2>{primary.job.jobId}</h2>
				</div>
				{compareJob ? (
					<div className="tbv-compare-summary">
						<span>vs {compareJob.jobId}</span>
						<strong>
							{rewardDelta === null
								? "Δ reward —"
								: `Δ reward ${(rewardDelta * 100).toFixed(1)} pts`}
						</strong>
					</div>
				) : null}
			</div>
			<div className="tbv-overview-grid">
				<article className="tbv-stat-card">
					<span>Mean reward</span>
					<strong>{formatPercent(primary.job.meanReward)}</strong>
				</article>
				<article className="tbv-stat-card">
					<span>Total duration</span>
					<strong>{formatSeconds(primary.job.totalDurationSec)}</strong>
				</article>
				<article className="tbv-stat-card">
					<span>Tasks</span>
					<strong>
						{primary.job.nTrials}
						{primary.job.nTotalTrials ? ` / ${primary.job.nTotalTrials}` : ""}
					</strong>
				</article>
				<article className="tbv-stat-card">
					<span>Errors</span>
					<strong>{primary.job.errorCount}</strong>
				</article>
			</div>
			{compareJob ? (
				<div className="tbv-compare-grid">
					<article className="tbv-compare-card">
						<span>Primary</span>
						<strong>{primary.job.jobId}</strong>
						<p>{formatPercent(primary.job.meanReward)} mean reward</p>
					</article>
					<article className="tbv-compare-card">
						<span>Compare</span>
						<strong>{compareJob.jobId}</strong>
						<p>{formatPercent(compareJob.meanReward)} mean reward</p>
					</article>
				</div>
			) : null}
		</section>
	);
};
