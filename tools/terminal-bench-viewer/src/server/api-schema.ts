export const viewerApiSchema = {
	name: "terminal-bench-viewer-api",
	version: "1",
	basePath: "/api",
	entrypoint: "/api/schema",
	notes: [
		"Local-only read-only API for Harbor job outputs.",
		"Fetch /api/schema first if you need endpoint discovery.",
		"All responses are JSON. No authentication is required.",
		"Task history and task aggregates default to completed jobs only unless include_partial=1 is passed.",
		"Benchmark datasets such as terminal-bench@2.0 and terminal-bench/terminal-bench-2-1 are separate analysis scopes; task aggregates and task history require dataset_label.",
	],
	recommendedFlow: [
		"GET /api/schema",
		"GET /api/config",
		"GET /api/jobs",
		"GET /api/jobs/{jobId}",
		"GET /api/tasks?recent_window=5",
		"GET /api/tasks/{taskName}/history",
	],
	endpoints: [
		{
			method: "GET",
			path: "/api/health",
			summary: "Health check.",
			query: [],
			responseShape: {
				ok: "boolean",
			},
		},
		{
			method: "GET",
			path: "/api/schema",
			summary:
				"Machine-readable API discovery document for agents and automation.",
			query: [],
			responseShape: "ViewerApiSchema",
		},
		{
			method: "GET",
			path: "/api/config",
			summary: "Resolved viewer config, including the active jobs_dir.",
			query: [],
			responseShape: "ViewerConfigResolved",
		},
		{
			method: "GET",
			path: "/api/jobs",
			summary: "Parsed jobs, newest first, optionally scoped to one dataset.",
			query: [
				{
					name: "dataset_label",
					type: "string",
					required: false,
					description:
						"Restrict jobs to one benchmark dataset label from JobSummary.datasetLabel.",
				},
			],
			responseShape: {
				jobs: "JobSummary[]",
			},
		},
		{
			method: "GET",
			path: "/api/jobs/{jobId}",
			summary: "One job summary plus its per-task rows.",
			pathParams: [
				{
					name: "jobId",
					type: "string",
					required: true,
					description: "Directory name of the Harbor job.",
				},
			],
			query: [],
			responseShape: "JobDetail",
			errorResponses: [
				{
					status: 404,
					shape: { error: "job not found" },
				},
			],
		},
		{
			method: "GET",
			path: "/api/tasks",
			summary: "Task-level aggregate metrics across jobs.",
			query: [
				{
					name: "include_partial",
					type: "boolean-ish string",
					required: false,
					description: "Include partial jobs when set to 1/true/yes/on.",
				},
				{
					name: "recent_window",
					type: "positive integer",
					required: false,
					description:
						"Use the most recent N runs per task for window metrics.",
				},
				{
					name: "recent_days",
					type: "positive integer",
					required: false,
					description: "Use runs within the last N days for window metrics.",
				},
				{
					name: "model_name",
					type: "string",
					required: false,
					description: "Restrict aggregates to one job model_name.",
				},
				{
					name: "dataset_label",
					type: "string",
					required: true,
					description:
						"Required benchmark dataset label. This keeps Terminal-Bench versions separate.",
				},
			],
			responseShape: {
				tasks: "TaskAggregateSummary[]",
			},
		},
		{
			method: "GET",
			path: "/api/tasks/{taskName}/history",
			summary: "Per-job history for one task, newest first.",
			pathParams: [
				{
					name: "taskName",
					type: "string",
					required: true,
					description: "Terminal-Bench task_name from result.json.",
				},
			],
			query: [
				{
					name: "include_partial",
					type: "boolean-ish string",
					required: false,
					description: "Include partial jobs when set to 1/true/yes/on.",
				},
				{
					name: "job_ids",
					type: "comma-separated string",
					required: false,
					description: "Restrict history rows to specific job ids.",
				},
				{
					name: "model_name",
					type: "string",
					required: false,
					description: "Restrict history rows to one job model_name.",
				},
				{
					name: "dataset_label",
					type: "string",
					required: true,
					description:
						"Required benchmark dataset label. This keeps Terminal-Bench versions separate.",
				},
			],
			responseShape: {
				history: "TaskHistoryPoint[]",
			},
		},
	],
	types: {
		ViewerConfigResolved: {
			jobsDir: "string",
			configFiles: "string[]",
		},
		JobSummary: {
			jobId: "string",
			jobName: "string",
			status: '"completed" | "partial" | "unreadable"',
			startedAt: "string | null",
			finishedAt: "string | null",
			totalDurationSec: "number | null",
			meanExecutionSec: "number | null",
			nTrials: "number",
			nTotalTrials: "number | null",
			parsedTaskCount: "number",
			unreadableTaskCount: "number",
			meanReward: "number | null",
			errorCount: "number",
			modelName: "string | null",
			datasetLabel: "string | null",
		},
		TaskResultRow: {
			taskName: "string",
			trialName: "string",
			reward: "number | null",
			success: "boolean",
			totalSec: "number | null",
			executionSec: "number | null",
			exceptionType: "string | null",
			exceptionMessage: "string | null",
			startedAt: "string | null",
			finishedAt: "string | null",
		},
		JobDetail: {
			job: "JobSummary",
			tasks: "TaskResultRow[]",
		},
		TaskAggregateSummary: {
			taskName: "string",
			runs: "number",
			completedRuns: "number",
			partialRuns: "number",
			successRate: "number | null",
			meanReward: "number | null",
			meanTotalSec: "number | null",
			meanExecutionSec: "number | null",
			windowLabel: "string",
			windowRuns: "number",
			windowSuccessRate: "number | null",
			windowSuccessDelta: "number | null",
			windowMeanReward: "number | null",
			windowMeanExecutionSec: "number | null",
			windowRewardDelta: "number | null",
			windowExecutionDeltaSec: "number | null",
			lastSeenAt: "string | null",
		},
		TaskHistoryPoint: {
			jobId: "string",
			jobName: "string",
			jobStatus: '"completed" | "partial" | "unreadable"',
			modelName: "string | null",
			datasetLabel: "string | null",
			startedAt: "string | null",
			finishedAt: "string | null",
			reward: "number | null",
			success: "boolean",
			totalSec: "number | null",
			executionSec: "number | null",
			exceptionType: "string | null",
		},
	},
	examples: [
		{
			name: "recent task degradation scan",
			request:
				"/api/tasks?dataset_label=terminal-bench%2Fterminal-bench-2-1&recent_window=10&model_name=openai/gpt-5.3-codex",
			note: "Sort by windowSuccessDelta ascending to find recently degraded tasks for one model within one benchmark dataset.",
		},
		{
			name: "task history for one task",
			request: "/api/tasks/modernize-scientific-stack/history",
			note: "Add include_partial=1 or model_name=<model> to narrow the rows.",
		},
	],
} as const;

export type ViewerApiSchema = typeof viewerApiSchema;
