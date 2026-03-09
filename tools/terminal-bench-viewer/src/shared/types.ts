export type JobStatus = "completed" | "partial" | "unreadable";

export interface ViewerConfigResolved {
	jobsDir: string;
	configFiles: string[];
}

export interface JobSummary {
	jobId: string;
	jobName: string;
	status: JobStatus;
	startedAt: string | null;
	finishedAt: string | null;
	totalDurationSec: number | null;
	meanExecutionSec: number | null;
	nTrials: number;
	nTotalTrials: number | null;
	parsedTaskCount: number;
	unreadableTaskCount: number;
	meanReward: number | null;
	errorCount: number;
	modelName: string | null;
	datasetLabel: string | null;
}

export interface TaskResultRow {
	taskName: string;
	trialName: string;
	reward: number | null;
	success: boolean;
	totalSec: number | null;
	executionSec: number | null;
	exceptionType: string | null;
	exceptionMessage: string | null;
	startedAt: string | null;
	finishedAt: string | null;
}

export interface JobDetail {
	job: JobSummary;
	tasks: TaskResultRow[];
}

export interface TaskHistoryPoint {
	jobId: string;
	jobName: string;
	jobStatus: JobStatus;
	modelName: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	reward: number | null;
	success: boolean;
	totalSec: number | null;
	executionSec: number | null;
	exceptionType: string | null;
}

export interface TaskAggregateSummary {
	taskName: string;
	runs: number;
	completedRuns: number;
	partialRuns: number;
	successRate: number | null;
	meanReward: number | null;
	meanTotalSec: number | null;
	meanExecutionSec: number | null;
	windowLabel: string;
	windowRuns: number;
	windowSuccessRate: number | null;
	windowSuccessDelta: number | null;
	windowMeanReward: number | null;
	windowMeanExecutionSec: number | null;
	windowRewardDelta: number | null;
	windowExecutionDeltaSec: number | null;
	lastSeenAt: string | null;
}
