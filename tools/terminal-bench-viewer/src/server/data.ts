import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
	JobDetail,
	JobStatus,
	JobSummary,
	TaskAggregateSummary,
	TaskHistoryPoint,
	TaskResultRow,
} from "../shared/types";

interface JobsSnapshot {
	jobs: JobDetail[];
}

interface JsonReadSuccess<T> {
	ok: true;
	value: T;
}

interface JsonReadFailure {
	ok: false;
	error: string;
}

type JsonReadResult<T> = JsonReadSuccess<T> | JsonReadFailure;

interface AggregateWindowOptions {
	recentWindow?: number;
	recentDays?: number;
}

const CACHE_TTL_MS = 2_000;

let cache:
	| {
			jobsDir: string;
			loadedAt: number;
			snapshot: JobsSnapshot;
	  }
	| null = null;

const readJson = async <T>(filePath: string): Promise<JsonReadResult<T>> => {
	try {
		const raw = await readFile(filePath, "utf8");
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
};

const parseDurationSeconds = (
	startedAt: string | null | undefined,
	finishedAt: string | null | undefined,
) => {
	if (!startedAt || !finishedAt) return null;
	const start = Date.parse(startedAt);
	const finish = Date.parse(finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
		return null;
	}
	return Math.round((finish - start) / 1000);
};

const parseReward = (input: unknown) => {
	const value = Number(input);
	return Number.isFinite(value) ? value : null;
};

const meanOfNumbers = (values: number[]) =>
	values.length > 0
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: null;

const readMeanDuration = (
	tasks: TaskResultRow[],
	field: "totalSec" | "executionSec",
) => {
	const values = tasks
		.map((task) => task[field])
		.filter((value): value is number => typeof value === "number");
	if (values.length === 0) return null;
	return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
};

const readMeanReward = (jobResult: any, tasks: TaskResultRow[]) => {
	const evals = jobResult?.stats?.evals;
	if (evals && typeof evals === "object") {
		for (const value of Object.values(evals)) {
			const metricMean = Number((value as any)?.metrics?.[0]?.mean);
			if (Number.isFinite(metricMean)) {
				return metricMean;
			}
		}
	}
	const rewards = tasks
		.map((task) => task.reward)
		.filter((value): value is number => typeof value === "number");
	if (rewards.length === 0) return null;
	return rewards.reduce((sum, value) => sum + value, 0) / rewards.length;
};

const readDatasetLabel = (jobConfig: any) => {
	const dataset = jobConfig?.datasets?.[0];
	if (!dataset?.name || !dataset?.version) return null;
	return `${dataset.name}@${dataset.version}`;
};

const compareJobsDesc = (left: JobDetail, right: JobDetail) => {
	const leftKey = left.job.startedAt ?? left.job.jobId;
	const rightKey = right.job.startedAt ?? right.job.jobId;
	return rightKey.localeCompare(leftKey);
};

const compareTasks = (left: TaskResultRow, right: TaskResultRow) =>
	left.taskName.localeCompare(right.taskName);

const readTaskResult = async (trialDir: string): Promise<TaskResultRow | null> => {
	const trialResultPath = path.join(trialDir, "result.json");
	const trialResult = await readJson<any>(trialResultPath);
	if (!trialResult.ok) return null;

	const reward = parseReward(
		trialResult.value?.verifier_result?.rewards?.reward ??
			trialResult.value?.verifier_result?.reward,
	);

	return {
		taskName: String(trialResult.value?.task_name ?? path.basename(trialDir)),
		trialName: String(trialResult.value?.trial_name ?? path.basename(trialDir)),
		reward,
		success: reward !== null && reward > 0,
		totalSec: parseDurationSeconds(
			trialResult.value?.started_at,
			trialResult.value?.finished_at,
		),
		executionSec: parseDurationSeconds(
			trialResult.value?.agent_execution?.started_at,
			trialResult.value?.agent_execution?.finished_at,
		),
		exceptionType:
			typeof trialResult.value?.exception_info?.exception_type === "string"
				? trialResult.value.exception_info.exception_type
				: null,
		exceptionMessage:
			typeof trialResult.value?.exception_info?.exception_message === "string"
				? trialResult.value.exception_info.exception_message
				: null,
		startedAt:
			typeof trialResult.value?.started_at === "string"
				? trialResult.value.started_at
				: null,
		finishedAt:
			typeof trialResult.value?.finished_at === "string"
				? trialResult.value.finished_at
				: null,
	};
};

const readJobDetail = async (jobsDir: string, jobId: string): Promise<JobDetail> => {
	const jobDir = path.join(jobsDir, jobId);
	const jobConfigResult = await readJson<any>(path.join(jobDir, "config.json"));
	const jobResultResult = await readJson<any>(path.join(jobDir, "result.json"));
	const unreadableRoot = !jobConfigResult.ok || !jobResultResult.ok;

	const trialEntries = await readdir(jobDir, { withFileTypes: true });
	const tasks: TaskResultRow[] = [];
	let unreadableTaskCount = 0;

	for (const entry of trialEntries) {
		if (!entry.isDirectory()) continue;
		const taskResult = await readTaskResult(path.join(jobDir, entry.name));
		if (taskResult) {
			tasks.push(taskResult);
		} else {
			unreadableTaskCount += 1;
		}
	}

	tasks.sort(compareTasks);

	const jobResult = jobResultResult.ok ? jobResultResult.value : null;
	const jobConfig = jobConfigResult.ok ? jobConfigResult.value : null;

	const status: JobStatus = unreadableRoot
		? "unreadable"
		: typeof jobResult?.finished_at === "string" && jobResult.finished_at.length > 0
			? "completed"
			: "partial";

	const nTotalTrials = Number(jobResult?.n_total_trials);
	const statsTrials = Number(jobResult?.stats?.n_trials);
	const statsErrors = Number(jobResult?.stats?.n_errors);

	const summary: JobSummary = {
		jobId,
		jobName:
			typeof jobConfig?.job_name === "string" ? jobConfig.job_name : jobId,
		status,
		startedAt:
			typeof jobResult?.started_at === "string" ? jobResult.started_at : null,
		finishedAt:
			typeof jobResult?.finished_at === "string" ? jobResult.finished_at : null,
		totalDurationSec: parseDurationSeconds(
			jobResult?.started_at,
			jobResult?.finished_at,
		),
		meanExecutionSec: readMeanDuration(tasks, "executionSec"),
		nTrials: Number.isFinite(statsTrials) ? statsTrials : tasks.length,
		nTotalTrials: Number.isFinite(nTotalTrials) ? nTotalTrials : null,
		parsedTaskCount: tasks.length,
		unreadableTaskCount,
		meanReward: readMeanReward(jobResult, tasks),
		errorCount: Number.isFinite(statsErrors)
			? statsErrors
			: tasks.filter((task) => task.exceptionType !== null).length,
		modelName:
			typeof jobConfig?.agents?.[0]?.model_name === "string"
				? jobConfig.agents[0].model_name
				: null,
		datasetLabel: readDatasetLabel(jobConfig),
	};

	return { job: summary, tasks };
};

export const loadJobsSnapshot = async (jobsDir: string): Promise<JobsSnapshot> => {
	const entries = await readdir(jobsDir, { withFileTypes: true });
	const jobs = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
			.map((entry) => readJobDetail(jobsDir, entry.name)),
	);
	jobs.sort(compareJobsDesc);
	return { jobs };
};

export const getJobsSnapshot = async (jobsDir: string): Promise<JobsSnapshot> => {
	if (
		cache &&
		cache.jobsDir === jobsDir &&
		Date.now() - cache.loadedAt < CACHE_TTL_MS
	) {
		return cache.snapshot;
	}
	const snapshot = await loadJobsSnapshot(jobsDir);
	cache = {
		jobsDir,
		loadedAt: Date.now(),
		snapshot,
	};
	return snapshot;
};

export const listJobSummaries = async (jobsDir: string) => {
	const snapshot = await getJobsSnapshot(jobsDir);
	return snapshot.jobs.map((job) => job.job);
};

export const getJobDetail = async (jobsDir: string, jobId: string) => {
	const snapshot = await getJobsSnapshot(jobsDir);
	return snapshot.jobs.find((job) => job.job.jobId === jobId) ?? null;
};

export const getTaskHistory = async (
	jobsDir: string,
	taskName: string,
	includePartial: boolean,
	jobIds?: string[],
): Promise<TaskHistoryPoint[]> => {
	const snapshot = await getJobsSnapshot(jobsDir);
	const allowedJobIds = jobIds ? new Set(jobIds) : null;

	const rows: TaskHistoryPoint[] = [];
	for (const job of snapshot.jobs) {
		if (!includePartial && job.job.status !== "completed") continue;
		if (allowedJobIds && !allowedJobIds.has(job.job.jobId)) continue;
		const task = job.tasks.find((entry) => entry.taskName === taskName);
		if (!task) continue;
		rows.push({
			jobId: job.job.jobId,
			jobName: job.job.jobName,
			jobStatus: job.job.status,
			modelName: job.job.modelName,
			startedAt: job.job.startedAt,
			finishedAt: job.job.finishedAt,
			reward: task.reward,
			success: task.success,
			totalSec: task.totalSec,
			executionSec: task.executionSec,
			exceptionType: task.exceptionType,
		});
	}

	rows.sort((left, right) => {
		const leftKey = left.startedAt ?? left.jobId;
		const rightKey = right.startedAt ?? right.jobId;
		return rightKey.localeCompare(leftKey);
	});

	return rows;
};

export const listTaskAggregates = async (
	jobsDir: string,
	includePartial: boolean,
	options: AggregateWindowOptions = {},
): Promise<TaskAggregateSummary[]> => {
	const snapshot = await getJobsSnapshot(jobsDir);
	const recentWindow =
		Number.isFinite(options.recentWindow) && (options.recentWindow ?? 0) > 0
			? Math.trunc(options.recentWindow ?? 0)
			: null;
	const recentDays =
		Number.isFinite(options.recentDays) && (options.recentDays ?? 0) > 0
			? Math.trunc(options.recentDays ?? 0)
			: null;
	const cutoffMs =
		recentDays !== null ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : null;
	const rows = new Map<
		string,
		{
			runs: number;
			completedRuns: number;
			partialRuns: number;
			successCount: number;
			rewards: number[];
			totalSecs: number[];
			executionSecs: number[];
			samples: Array<{
				jobStartedAt: string | null;
				reward: number | null;
				executionSec: number | null;
				success: boolean;
			}>;
			lastSeenAt: string | null;
		}
	>();

	for (const job of snapshot.jobs) {
		if (job.job.status === "unreadable") continue;
		if (!includePartial && job.job.status !== "completed") continue;
		for (const task of job.tasks) {
			const current = rows.get(task.taskName) ?? {
				runs: 0,
				completedRuns: 0,
				partialRuns: 0,
				successCount: 0,
				rewards: [],
				totalSecs: [],
				executionSecs: [],
				samples: [],
				lastSeenAt: null,
			};
			current.runs += 1;
			if (job.job.status === "completed") {
				current.completedRuns += 1;
			} else if (job.job.status === "partial") {
				current.partialRuns += 1;
			}
			if (task.success) {
				current.successCount += 1;
			}
			if (typeof task.reward === "number") {
				current.rewards.push(task.reward);
			}
			if (typeof task.totalSec === "number") {
				current.totalSecs.push(task.totalSec);
			}
			if (typeof task.executionSec === "number") {
				current.executionSecs.push(task.executionSec);
			}
			current.samples.push({
				jobStartedAt: job.job.startedAt,
				reward: task.reward,
				executionSec: task.executionSec,
				success: task.success,
			});
			const candidateLastSeen = task.finishedAt ?? task.startedAt ?? job.job.startedAt;
			if (
				candidateLastSeen &&
				(!current.lastSeenAt || candidateLastSeen > current.lastSeenAt)
			) {
				current.lastSeenAt = candidateLastSeen;
			}
			rows.set(task.taskName, current);
		}
	}

	return [...rows.entries()]
		.map(([taskName, current]): TaskAggregateSummary => {
			const windowSamples = current.samples.filter((sample, index) => {
				if (recentWindow !== null) {
					return index < recentWindow;
				}
				if (cutoffMs !== null) {
					if (!sample.jobStartedAt) return false;
					const startedAtMs = Date.parse(sample.jobStartedAt);
					return Number.isFinite(startedAtMs) && startedAtMs >= cutoffMs;
				}
				return index < 5;
			});
			const windowRewards = windowSamples
				.map((sample) => sample.reward)
				.filter((value): value is number => typeof value === "number");
			const windowExecutionSecs = windowSamples
				.map((sample) => sample.executionSec)
				.filter((value): value is number => typeof value === "number");
			const successRate =
				current.runs > 0 ? current.successCount / current.runs : null;
			const meanReward = meanOfNumbers(current.rewards);
			const meanExecutionSec = meanOfNumbers(current.executionSecs);
			const windowSuccessRate =
				windowSamples.length > 0
					? windowSamples.filter((sample) => sample.success).length /
						windowSamples.length
					: null;
			const windowMeanReward = meanOfNumbers(windowRewards);
			const windowMeanExecutionSec = meanOfNumbers(windowExecutionSecs);

			return {
				taskName,
				runs: current.runs,
				completedRuns: current.completedRuns,
				partialRuns: current.partialRuns,
				successRate,
				meanReward,
				meanTotalSec:
					current.totalSecs.length > 0
						? Math.round(
								current.totalSecs.reduce((sum, value) => sum + value, 0) /
									current.totalSecs.length,
							)
						: null,
				meanExecutionSec:
					meanExecutionSec !== null ? Math.round(meanExecutionSec) : null,
				windowLabel:
					recentWindow !== null
						? `Last ${recentWindow} runs`
						: recentDays !== null
							? `Last ${recentDays} days`
							: "Last 5 runs",
				windowRuns: windowSamples.length,
				windowSuccessRate,
				windowSuccessDelta:
					windowSuccessRate !== null && successRate !== null
						? windowSuccessRate - successRate
						: null,
				windowMeanReward: windowMeanReward,
				windowMeanExecutionSec:
					windowMeanExecutionSec !== null
						? Math.round(windowMeanExecutionSec)
						: null,
				windowRewardDelta:
					windowMeanReward !== null && meanReward !== null
						? windowMeanReward - meanReward
						: null,
				windowExecutionDeltaSec:
					windowMeanExecutionSec !== null && meanExecutionSec !== null
						? Math.round(windowMeanExecutionSec - meanExecutionSec)
						: null,
				lastSeenAt: current.lastSeenAt,
			};
		})
		.sort((left, right) => {
			const leftSuccess = left.successRate ?? -1;
			const rightSuccess = right.successRate ?? -1;
			if (leftSuccess !== rightSuccess) {
				return rightSuccess - leftSuccess;
			}
			const leftDuration = left.meanExecutionSec ?? Number.MAX_SAFE_INTEGER;
			const rightDuration = right.meanExecutionSec ?? Number.MAX_SAFE_INTEGER;
			if (leftDuration !== rightDuration) {
				return leftDuration - rightDuration;
			}
			return left.taskName.localeCompare(right.taskName);
		});
};
