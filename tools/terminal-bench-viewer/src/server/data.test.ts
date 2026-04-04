import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getTaskHistory, listTaskAggregates, loadJobsSnapshot } from "./data";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const writeJson = async (filePath: string, value: unknown) => {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

describe("loadJobsSnapshot", () => {
	it("classifies completed and partial jobs", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tbv-jobs-"));
		tempDirs.push(tempRoot);

		await writeJson(path.join(tempRoot, "job-complete/config.json"), {
			job_name: "job-complete",
			agents: [{ model_name: "openai/gpt-5.3-codex" }],
			datasets: [{ name: "terminal-bench", version: "2.0" }],
		});
		await writeJson(path.join(tempRoot, "job-complete/result.json"), {
			started_at: "2026-03-09T03:00:00Z",
			finished_at: "2026-03-09T03:10:00Z",
			n_total_trials: 1,
			stats: {
				n_trials: 1,
				n_errors: 0,
				evals: { test: { metrics: [{ mean: 1 }] } },
			},
		});
		await writeJson(path.join(tempRoot, "job-complete/sample/result.json"), {
			task_name: "sample",
			trial_name: "sample__1",
			started_at: "2026-03-09T03:00:00Z",
			finished_at: "2026-03-09T03:05:00Z",
			agent_execution: {
				started_at: "2026-03-09T03:01:00Z",
				finished_at: "2026-03-09T03:04:00Z",
			},
			verifier_result: { rewards: { reward: 1 } },
		});

		await writeJson(path.join(tempRoot, "job-partial/config.json"), {
			job_name: "job-partial",
			agents: [{ model_name: "openai/gpt-5.3-codex" }],
			datasets: [{ name: "terminal-bench", version: "2.0" }],
		});
		await writeJson(path.join(tempRoot, "job-partial/result.json"), {
			started_at: "2026-03-09T04:00:00Z",
			finished_at: null,
			n_total_trials: 1,
			stats: { n_trials: 1, n_errors: 1 },
		});
		await writeJson(path.join(tempRoot, "job-partial/sample/result.json"), {
			task_name: "sample",
			trial_name: "sample__2",
			started_at: "2026-03-09T04:00:00Z",
			finished_at: "2026-03-09T04:02:00Z",
			verifier_result: { rewards: { reward: 0 } },
			exception_info: { exception_type: "CancelledError" },
		});

		const snapshot = await loadJobsSnapshot(tempRoot);
		expect(snapshot.jobs).toHaveLength(2);
		expect(snapshot.jobs[0]?.job.jobId).toBe("job-partial");
		expect(snapshot.jobs[0]?.job.status).toBe("partial");
		expect(snapshot.jobs[1]?.job.status).toBe("completed");
		expect(snapshot.jobs[1]?.tasks[0]?.success).toBe(true);
	});

	it("calculates recent-window task aggregate deltas", async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), "tbv-aggregate-"));
		tempDirs.push(tempRoot);

		const jobs = [
			{
				jobId: "job-a",
				startedAt: "2026-03-01T03:00:00Z",
				finishedAt: "2026-03-01T03:10:00Z",
				reward: 1,
				executionStartedAt: "2026-03-01T03:01:00Z",
				executionFinishedAt: "2026-03-01T03:02:40Z",
			},
			{
				jobId: "job-b",
				startedAt: "2026-03-02T03:00:00Z",
				finishedAt: "2026-03-02T03:10:00Z",
				reward: 0,
				executionStartedAt: "2026-03-02T03:01:00Z",
				executionFinishedAt: "2026-03-02T03:04:00Z",
			},
			{
				jobId: "job-c",
				startedAt: "2026-03-03T03:00:00Z",
				finishedAt: "2026-03-03T03:10:00Z",
				reward: 0,
				executionStartedAt: "2026-03-03T03:01:00Z",
				executionFinishedAt: "2026-03-03T03:05:00Z",
			},
		];

		for (const job of jobs) {
			await writeJson(path.join(tempRoot, job.jobId, "config.json"), {
				job_name: job.jobId,
				agents: [{ model_name: "openai/gpt-5.3-codex" }],
				datasets: [{ name: "terminal-bench", version: "2.0" }],
			});
			await writeJson(path.join(tempRoot, job.jobId, "result.json"), {
				started_at: job.startedAt,
				finished_at: job.finishedAt,
				n_total_trials: 1,
				stats: {
					n_trials: 1,
					n_errors: 0,
					evals: { test: { metrics: [{ mean: job.reward }] } },
				},
			});
			await writeJson(path.join(tempRoot, job.jobId, "sample/result.json"), {
				task_name: "sample",
				trial_name: `${job.jobId}__sample`,
				started_at: job.startedAt,
				finished_at: job.finishedAt,
				agent_execution: {
					started_at: job.executionStartedAt,
					finished_at: job.executionFinishedAt,
				},
				verifier_result: { rewards: { reward: job.reward } },
			});
		}

		const aggregates = await listTaskAggregates(tempRoot, false, {
			recentWindow: 2,
		});

		expect(aggregates).toHaveLength(1);
		expect(aggregates[0]?.taskName).toBe("sample");
		expect(aggregates[0]?.runs).toBe(3);
		expect(aggregates[0]?.successRate).toBeCloseTo(1 / 3, 5);
		expect(aggregates[0]?.windowRuns).toBe(2);
		expect(aggregates[0]?.windowSuccessRate).toBe(0);
		expect(aggregates[0]?.windowSuccessDelta).toBeCloseTo(-1 / 3, 5);
		expect(aggregates[0]?.windowMeanExecutionSec).toBe(210);
		expect(aggregates[0]?.windowExecutionDeltaSec).toBeGreaterThan(0);
	});

	it("filters task history by model name", async () => {
		const tempRoot = await mkdtemp(
			path.join(os.tmpdir(), "tbv-history-model-"),
		);
		tempDirs.push(tempRoot);

		const jobs = [
			{
				jobId: "job-a",
				modelName: "openai/gpt-5.3-codex",
				startedAt: "2026-03-01T03:00:00Z",
				finishedAt: "2026-03-01T03:10:00Z",
				reward: 1,
			},
			{
				jobId: "job-b",
				modelName: "anthropic/claude-sonnet-4.5",
				startedAt: "2026-03-02T03:00:00Z",
				finishedAt: "2026-03-02T03:10:00Z",
				reward: 0,
			},
		];

		for (const job of jobs) {
			await writeJson(path.join(tempRoot, job.jobId, "config.json"), {
				job_name: job.jobId,
				agents: [{ model_name: job.modelName }],
				datasets: [{ name: "terminal-bench", version: "2.0" }],
			});
			await writeJson(path.join(tempRoot, job.jobId, "result.json"), {
				started_at: job.startedAt,
				finished_at: job.finishedAt,
				n_total_trials: 1,
				stats: {
					n_trials: 1,
					n_errors: 0,
					evals: { test: { metrics: [{ mean: job.reward }] } },
				},
			});
			await writeJson(path.join(tempRoot, job.jobId, "sample/result.json"), {
				task_name: "sample",
				trial_name: `${job.jobId}__sample`,
				started_at: job.startedAt,
				finished_at: job.finishedAt,
				verifier_result: { rewards: { reward: job.reward } },
			});
		}

		const history = await getTaskHistory(
			tempRoot,
			"sample",
			false,
			undefined,
			"openai/gpt-5.3-codex",
		);

		expect(history).toHaveLength(1);
		expect(history[0]?.jobId).toBe("job-a");
		expect(history[0]?.modelName).toBe("openai/gpt-5.3-codex");
	});

	it("filters task aggregates by model name", async () => {
		const tempRoot = await mkdtemp(
			path.join(os.tmpdir(), "tbv-aggregate-model-"),
		);
		tempDirs.push(tempRoot);

		const jobs = [
			{
				jobId: "job-a",
				modelName: "openai/gpt-5.3-codex",
				startedAt: "2026-03-01T03:00:00Z",
				finishedAt: "2026-03-01T03:10:00Z",
				taskName: "sample-a",
				reward: 1,
			},
			{
				jobId: "job-b",
				modelName: "anthropic/claude-sonnet-4.5",
				startedAt: "2026-03-02T03:00:00Z",
				finishedAt: "2026-03-02T03:10:00Z",
				taskName: "sample-b",
				reward: 0,
			},
		];

		for (const job of jobs) {
			await writeJson(path.join(tempRoot, job.jobId, "config.json"), {
				job_name: job.jobId,
				agents: [{ model_name: job.modelName }],
				datasets: [{ name: "terminal-bench", version: "2.0" }],
			});
			await writeJson(path.join(tempRoot, job.jobId, "result.json"), {
				started_at: job.startedAt,
				finished_at: job.finishedAt,
				n_total_trials: 1,
				stats: {
					n_trials: 1,
					n_errors: 0,
					evals: { test: { metrics: [{ mean: job.reward }] } },
				},
			});
			await writeJson(
				path.join(tempRoot, job.jobId, `${job.taskName}/result.json`),
				{
					task_name: job.taskName,
					trial_name: `${job.jobId}__${job.taskName}`,
					started_at: job.startedAt,
					finished_at: job.finishedAt,
					verifier_result: { rewards: { reward: job.reward } },
				},
			);
		}

		const aggregates = await listTaskAggregates(tempRoot, false, {
			modelName: "openai/gpt-5.3-codex",
		});

		expect(aggregates).toHaveLength(1);
		expect(aggregates[0]?.taskName).toBe("sample-a");
	});
});
