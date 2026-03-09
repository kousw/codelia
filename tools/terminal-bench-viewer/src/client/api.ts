import type {
	JobDetail,
	JobSummary,
	TaskAggregateSummary,
	TaskHistoryPoint,
	ViewerConfigResolved,
} from "../shared/types";

const fetchJson = async <T>(input: string): Promise<T> => {
	const response = await fetch(input);
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`);
	}
	return (await response.json()) as T;
};

export const fetchConfig = () => fetchJson<ViewerConfigResolved>("/api/config");

export const fetchJobs = async () => {
	const payload = await fetchJson<{ jobs: JobSummary[] }>("/api/jobs");
	return payload.jobs;
};

export const fetchTaskAggregates = async (
	includePartial: boolean,
	options: { recentWindow?: number; recentDays?: number } = {},
) => {
	const params = new URLSearchParams();
	if (includePartial) {
		params.set("include_partial", "1");
	}
	if (options.recentWindow) {
		params.set("recent_window", String(options.recentWindow));
	}
	if (options.recentDays) {
		params.set("recent_days", String(options.recentDays));
	}
	const query = params.toString();
	const payload = await fetchJson<{ tasks: TaskAggregateSummary[] }>(
		`/api/tasks${query ? `?${query}` : ""}`,
	);
	return payload.tasks;
};

export const fetchJobDetail = (jobId: string) =>
	fetchJson<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);

export const fetchTaskHistory = async (
	taskName: string,
	includePartial: boolean,
	jobIds?: string[],
) => {
	const params = new URLSearchParams();
	if (includePartial) {
		params.set("include_partial", "1");
	}
	if (jobIds && jobIds.length > 0) {
		params.set("job_ids", jobIds.join(","));
	}
	const query = params.toString();
	const payload = await fetchJson<{ history: TaskHistoryPoint[] }>(
		`/api/tasks/${encodeURIComponent(taskName)}/history${
			query ? `?${query}` : ""
		}`,
	);
	return payload.history;
};
