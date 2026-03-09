import type { JobStatus, JobSummary } from "../../shared/types";

interface StatusFilter {
	completed: boolean;
	partial: boolean;
	unreadable: boolean;
}

interface JobListPaneProps {
	jobs: JobSummary[];
	search: string;
	onSearchChange: (value: string) => void;
	statusFilter: StatusFilter;
	onToggleStatus: (status: JobStatus) => void;
	modelFilter: string;
	onModelFilterChange: (value: string) => void;
	modelOptions: string[];
	primaryJobId: string | null;
	compareJobId: string | null;
	onSelectPrimary: (jobId: string) => void;
	onSelectCompare: (jobId: string) => void;
	onRefresh: () => void;
}

const statusLabel: Record<JobStatus, string> = {
	completed: "Completed",
	partial: "Partial",
	unreadable: "Unreadable",
};

export const JobListPane = ({
	jobs,
	search,
	onSearchChange,
	statusFilter,
	onToggleStatus,
	modelFilter,
	onModelFilterChange,
	modelOptions,
	primaryJobId,
	compareJobId,
	onSelectPrimary,
	onSelectCompare,
	onRefresh,
}: JobListPaneProps) => (
	<aside className="tbv-sidebar">
		<div className="tbv-sidebar-header">
			<div>
				<p className="tbv-eyebrow">Jobs</p>
				<h2>Runs</h2>
			</div>
			<button type="button" className="tbv-ghost-button" onClick={onRefresh}>
				Refresh
			</button>
		</div>
		<label className="tbv-input-block">
			<span>Search</span>
			<input
				value={search}
				onChange={(event) => onSearchChange(event.target.value)}
				placeholder="job name, model, dataset"
			/>
		</label>
		<div className="tbv-filter-block">
			<span>Status</span>
			<div className="tbv-pill-row">
				{(["completed", "partial", "unreadable"] as const).map((status) => (
					<button
						key={status}
						type="button"
						className={`tbv-pill${statusFilter[status] ? " is-active" : ""}`}
						onClick={() => onToggleStatus(status)}
					>
						{statusLabel[status]}
					</button>
				))}
			</div>
		</div>
		<label className="tbv-input-block">
			<span>Model</span>
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
		<div className="tbv-job-list">
			{jobs.map((job) => (
				<section
					key={job.jobId}
					className={`tbv-job-card status-${job.status}${
						job.jobId === primaryJobId ? " is-primary" : ""
					}${job.jobId === compareJobId ? " is-compare" : ""}`}
				>
					<div className="tbv-job-card-header">
						<div>
							<h3>{job.jobId}</h3>
							<p>{job.modelName ?? "unknown model"}</p>
						</div>
						<span className="tbv-status-badge">{statusLabel[job.status]}</span>
					</div>
					<div className="tbv-job-meta">
						<span>{job.datasetLabel ?? "no dataset"}</span>
						<span>
							{job.nTrials}
							{job.nTotalTrials ? ` / ${job.nTotalTrials}` : ""} tasks
						</span>
					</div>
					<div className="tbv-job-actions">
						<button
							type="button"
							className="tbv-primary-button"
							onClick={() => onSelectPrimary(job.jobId)}
						>
							{job.jobId === primaryJobId ? "Primary" : "Set primary"}
						</button>
						<button
							type="button"
							className="tbv-ghost-button"
							onClick={() => onSelectCompare(job.jobId)}
						>
							{job.jobId === compareJobId ? "Compare" : "Compare with"}
						</button>
					</div>
				</section>
			))}
		</div>
	</aside>
);
