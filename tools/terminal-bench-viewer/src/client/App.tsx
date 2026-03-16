import {
	startTransition,
	useDeferredValue,
	useEffect,
	useEffectEvent,
	useState,
} from "react";
import type {
	JobDetail,
	JobStatus,
	JobSummary,
	TaskAggregateSummary,
	TaskHistoryPoint,
	ViewerConfigResolved,
} from "../shared/types";
import {
	fetchConfig,
	fetchJobDetail,
	fetchJobs,
	fetchTaskAggregates,
	fetchTaskHistory,
} from "./api";
import { JobListPane } from "./components/JobListPane";
import { JobOverview } from "./components/JobOverview";
import { TaskAggregatePanel } from "./components/TaskAggregatePanel";
import { TaskHistoryPanel } from "./components/TaskHistoryPanel";
import { TaskTable } from "./components/TaskTable";
import { TrendPanel } from "./components/TrendPanel";

interface StatusFilter {
	completed: boolean;
	partial: boolean;
	unreadable: boolean;
}

type ViewMode = "jobs" | "tasks";

const initialStatusFilter: StatusFilter = {
	completed: true,
	partial: true,
	unreadable: true,
};

const isStatusVisible = (statusFilter: StatusFilter, status: JobStatus) =>
	statusFilter[status];

const collectModelOptions = (jobs: JobSummary[]) =>
	[
		...new Set(jobs.map((job) => job.modelName).filter(Boolean) as string[]),
	].sort();

export const App = () => {
	const [config, setConfig] = useState<ViewerConfigResolved | null>(null);
	const [jobs, setJobs] = useState<JobSummary[]>([]);
	const [jobsError, setJobsError] = useState<string | null>(null);
	const [loadingJobs, setLoadingJobs] = useState(true);
	const [search, setSearch] = useState("");
	const [taskSearch, setTaskSearch] = useState("");
	const [modelFilter, setModelFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState(initialStatusFilter);
	const [primaryJobId, setPrimaryJobId] = useState<string | null>(null);
	const [compareJobId, setCompareJobId] = useState<string | null>(null);
	const [jobDetails, setJobDetails] = useState<Record<string, JobDetail>>({});
	const [selectedTaskName, setSelectedTaskName] = useState<string | null>(null);
	const [taskHistory, setTaskHistory] = useState<TaskHistoryPoint[]>([]);
	const [taskHistoryError, setTaskHistoryError] = useState<string | null>(null);
	const [taskHistoryLoading, setTaskHistoryLoading] = useState(false);
	const [includePartialHistory, setIncludePartialHistory] = useState(false);
	const [taskHistoryModelFilter, setTaskHistoryModelFilter] = useState("");
	const [includePartialTrend, setIncludePartialTrend] = useState(false);
	const [includePartialAggregate, setIncludePartialAggregate] = useState(false);
	const [taskAggregateModelFilter, setTaskAggregateModelFilter] = useState("");
	const [taskAggregates, setTaskAggregates] = useState<TaskAggregateSummary[]>(
		[],
	);
	const [taskAggregateLoading, setTaskAggregateLoading] = useState(false);
	const [taskAggregateError, setTaskAggregateError] = useState<string | null>(
		null,
	);
	const [taskAggregateSearch, setTaskAggregateSearch] = useState("");
	const [viewMode, setViewMode] = useState<ViewMode>("jobs");
	const [taskAggregateWindowMode, setTaskAggregateWindowMode] = useState<
		"runs" | "days"
	>("runs");
	const [taskAggregateWindowValue, setTaskAggregateWindowValue] = useState(5);

	const deferredSearch = useDeferredValue(search);
	const deferredTaskSearch = useDeferredValue(taskSearch);

	const loadJobs = useEffectEvent(async () => {
		setLoadingJobs(true);
		setJobsError(null);
		try {
			const [nextConfig, nextJobs] = await Promise.all([
				fetchConfig(),
				fetchJobs(),
			]);
			setConfig(nextConfig);
			setJobs(nextJobs);
		} catch (error) {
			setJobsError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoadingJobs(false);
		}
	});

	useEffect(() => {
		void loadJobs();
	}, []);

	useEffect(() => {
		setTaskAggregateLoading(true);
		setTaskAggregateError(null);
		void fetchTaskAggregates(includePartialAggregate, {
			recentWindow:
				taskAggregateWindowMode === "runs"
					? taskAggregateWindowValue
					: undefined,
			recentDays:
				taskAggregateWindowMode === "days"
					? taskAggregateWindowValue
					: undefined,
			modelName: taskAggregateModelFilter || undefined,
		}).then(
			(tasks) => {
				setTaskAggregates(tasks);
				setTaskAggregateLoading(false);
			},
			(error) => {
				setTaskAggregateError(
					error instanceof Error ? error.message : String(error),
				);
				setTaskAggregateLoading(false);
			},
		);
	}, [
		includePartialAggregate,
		taskAggregateModelFilter,
		taskAggregateWindowMode,
		taskAggregateWindowValue,
	]);

	const normalizedSearch = deferredSearch.trim().toLowerCase();
	const filteredJobs = jobs.filter((job) => {
		if (!isStatusVisible(statusFilter, job.status)) return false;
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
	});

	useEffect(() => {
		if (!primaryJobId && filteredJobs.length > 0) {
			setPrimaryJobId(filteredJobs[0]?.jobId ?? null);
			return;
		}
		if (
			primaryJobId &&
			!filteredJobs.some((job) => job.jobId === primaryJobId)
		) {
			setPrimaryJobId(filteredJobs[0]?.jobId ?? null);
		}
	}, [filteredJobs, primaryJobId]);

	useEffect(() => {
		const jobIds = [primaryJobId, compareJobId].filter(
			(value): value is string => typeof value === "string",
		);
		for (const jobId of jobIds) {
			if (jobDetails[jobId]) continue;
			void fetchJobDetail(jobId)
				.then((detail) => {
					setJobDetails((current) => ({ ...current, [jobId]: detail }));
				})
				.catch((error) => {
					console.error(
						"[terminal-bench-viewer] failed to load job detail",
						error,
					);
				});
		}
	}, [primaryJobId, compareJobId, jobDetails]);

	useEffect(() => {
		if (!selectedTaskName) {
			setTaskHistory([]);
			setTaskHistoryError(null);
			return;
		}
		setTaskHistoryLoading(true);
		setTaskHistoryError(null);
		void fetchTaskHistory(
			selectedTaskName,
			includePartialHistory,
			undefined,
			taskHistoryModelFilter || undefined,
		).then(
			(history) => {
				setTaskHistory(history);
				setTaskHistoryLoading(false);
			},
			(error) => {
				setTaskHistoryError(
					error instanceof Error ? error.message : String(error),
				);
				setTaskHistoryLoading(false);
			},
		);
	}, [selectedTaskName, includePartialHistory, taskHistoryModelFilter]);

	const primaryDetail = primaryJobId
		? (jobDetails[primaryJobId] ?? null)
		: null;
	const compareDetail = compareJobId
		? (jobDetails[compareJobId] ?? null)
		: null;
	const modelOptions = collectModelOptions(jobs);

	const highlightedJobIds = [primaryJobId, compareJobId].filter(
		(value): value is string => typeof value === "string",
	);

	return (
		<div className="tbv-app">
			<div className="tbv-background" aria-hidden="true" />
			<header className="tbv-topbar">
				<div>
					<p className="tbv-eyebrow">Terminal-Bench Viewer</p>
					<h1>Harbor result browser</h1>
				</div>
				<div className="tbv-topbar-meta">
					<span>{config?.jobsDir ?? "Loading config…"}</span>
					<strong>{filteredJobs.length} visible jobs</strong>
				</div>
			</header>
			{jobsError ? <p className="tbv-error">{jobsError}</p> : null}
			<div className="tbv-layout">
				<JobListPane
					jobs={filteredJobs}
					search={search}
					onSearchChange={setSearch}
					statusFilter={statusFilter}
					onToggleStatus={(status) =>
						setStatusFilter((current) => ({
							...current,
							[status]: !current[status],
						}))
					}
					modelFilter={modelFilter}
					onModelFilterChange={setModelFilter}
					modelOptions={modelOptions}
					primaryJobId={primaryJobId}
					compareJobId={compareJobId}
					onSelectPrimary={(jobId) =>
						startTransition(() => {
							setPrimaryJobId(jobId);
							if (compareJobId === jobId) {
								setCompareJobId(null);
							}
						})
					}
					onSelectCompare={(jobId) =>
						startTransition(() => {
							setCompareJobId((current) => (current === jobId ? null : jobId));
						})
					}
					onRefresh={() => {
						setJobDetails({});
						void loadJobs();
					}}
				/>
				<main className="tbv-main">
					<div className="tbv-view-switch">
						<button
							type="button"
							className={`tbv-pill${viewMode === "jobs" ? " is-active" : ""}`}
							onClick={() => setViewMode("jobs")}
						>
							Jobs
						</button>
						<button
							type="button"
							className={`tbv-pill${viewMode === "tasks" ? " is-active" : ""}`}
							onClick={() => setViewMode("tasks")}
						>
							Tasks
						</button>
					</div>
					<div className="tbv-strip">
						<article className="tbv-highlight-card">
							<span>Completed</span>
							<strong>
								{jobs.filter((job) => job.status === "completed").length}
							</strong>
						</article>
						<article className="tbv-highlight-card">
							<span>Partial</span>
							<strong>
								{jobs.filter((job) => job.status === "partial").length}
							</strong>
						</article>
						<article className="tbv-highlight-card">
							<span>Unreadable</span>
							<strong>
								{jobs.filter((job) => job.status === "unreadable").length}
							</strong>
						</article>
						<article className="tbv-highlight-card">
							<span>Loading</span>
							<strong>{loadingJobs ? "syncing" : "idle"}</strong>
						</article>
					</div>
					{viewMode === "jobs" ? (
						<>
							<TrendPanel
								jobs={jobs}
								search={search}
								modelFilter={modelFilter}
								includePartial={includePartialTrend}
								onToggleIncludePartial={() =>
									setIncludePartialTrend((current) => !current)
								}
							/>
							<JobOverview primary={primaryDetail} compare={compareDetail} />
							<TaskTable
								primary={primaryDetail}
								compare={compareDetail}
								selectedTaskName={selectedTaskName}
								taskSearch={deferredTaskSearch}
								onTaskSearchChange={setTaskSearch}
								onSelectTask={setSelectedTaskName}
							/>
						</>
					) : (
						<TaskAggregatePanel
							tasks={taskAggregates}
							loading={taskAggregateLoading}
							error={taskAggregateError}
							search={taskAggregateSearch}
							onSearchChange={setTaskAggregateSearch}
							includePartial={includePartialAggregate}
							onToggleIncludePartial={() =>
								setIncludePartialAggregate((current) => !current)
							}
							modelFilter={taskAggregateModelFilter}
							onModelFilterChange={setTaskAggregateModelFilter}
							modelOptions={modelOptions}
							windowMode={taskAggregateWindowMode}
							onWindowModeChange={(value) => {
								setTaskAggregateWindowMode(value);
								setTaskAggregateWindowValue(value === "runs" ? 5 : 7);
							}}
							windowValue={taskAggregateWindowValue}
							onWindowValueChange={setTaskAggregateWindowValue}
							selectedTaskName={selectedTaskName}
							onSelectTask={setSelectedTaskName}
						/>
					)}
					<TaskHistoryPanel
						taskName={selectedTaskName}
						history={taskHistory}
						loading={taskHistoryLoading}
						error={taskHistoryError}
						includePartial={includePartialHistory}
						onToggleIncludePartial={() =>
							setIncludePartialHistory((current) => !current)
						}
						modelFilter={taskHistoryModelFilter}
						onModelFilterChange={setTaskHistoryModelFilter}
						modelOptions={modelOptions}
						highlightedJobIds={highlightedJobIds}
					/>
				</main>
			</div>
		</div>
	);
};
