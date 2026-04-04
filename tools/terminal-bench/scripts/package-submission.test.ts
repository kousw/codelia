import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { packageSubmission, validateJobConfig } from "./package-submission.mjs";

const tempDirs = [];

afterEach(async () => {
	await Promise.all(
		tempDirs
			.splice(0)
			.map((dirPath) => rm(dirPath, { recursive: true, force: true })),
	);
});

const createTempDir = async () => {
	const dirPath = await mkdtemp(path.join(os.tmpdir(), "codelia-tb-package-"));
	tempDirs.push(dirPath);
	return dirPath;
};

const writeJson = async (filePath, value) => {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const createJob = async ({
	jobsRoot,
	jobName,
	taskName,
	suffix,
	modelProvider = "openai",
	modelName = "gpt-5.3-codex",
	maxRetries = 0,
	timeoutMultiplier = 1.0,
}) => {
	const jobDir = path.join(jobsRoot, jobName);
	const trialName = `${taskName}__${suffix}`;
	const trialDir = path.join(jobDir, trialName);
	await mkdir(path.join(trialDir, "agent"), { recursive: true });
	await mkdir(path.join(trialDir, "verifier"), { recursive: true });

	await writeJson(path.join(jobDir, "config.json"), {
		timeout_multiplier: timeoutMultiplier,
		orchestrator: { retry: { max_retries: maxRetries } },
		environment: {
			override_cpus: null,
			override_memory_mb: null,
			override_storage_mb: null,
		},
		verifier: {
			override_timeout_sec: null,
			max_timeout_sec: null,
		},
		agents: [
			{
				override_timeout_sec: null,
				max_timeout_sec: null,
			},
		],
	});
	await writeJson(path.join(jobDir, "result.json"), {
		finished_at: "2026-03-21T00:00:00Z",
	});
	await writeJson(path.join(trialDir, "result.json"), {
		task_name: taskName,
		finished_at: "2026-03-21T00:00:00Z",
		agent_info: {
			model_info: {
				provider: modelProvider,
				name: modelName,
			},
		},
		config: {
			agent: {
				model_name: `${modelProvider}/${modelName}`,
			},
		},
	});
	await writeFile(path.join(trialDir, "agent", "codelia-output.log"), "ok\n");
	await writeFile(path.join(trialDir, "verifier", "reward.txt"), "1.0\n");

	return jobDir;
};

describe("package-submission", () => {
	test("writes leaderboard metadata.yaml using the official schema", async () => {
		const tempRoot = await createTempDir();
		const jobsRoot = path.join(tempRoot, "jobs");
		const outDir = path.join(tempRoot, "out");
		await mkdir(jobsRoot, { recursive: true });

		const jobs = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				createJob({
					jobsRoot,
					jobName: `job-${index + 1}`,
					taskName: "headless-terminal",
					suffix: `trial${index + 1}`,
				}),
			),
		);

		const result = await packageSubmission({
			jobs,
			outDir,
			benchmark: "terminal-bench",
			version: "2.0",
			agentName: "Codelia",
			agentDisplayName: "Codelia CLI",
			agentOrgDisplayName: "Codelia",
			agentUrl: "https://github.com/kousw/codelia",
			modelName: undefined,
			modelProvider: undefined,
			modelDisplayName: undefined,
			modelOrgDisplayName: undefined,
			notes: "",
		});

		expect(result.warnings).toEqual([]);

		const metadataYaml = await readFile(
			path.join(result.submissionDir, "metadata.yaml"),
			"utf8",
		);
		expect(metadataYaml).toContain(
			'agent_url: "https://github.com/kousw/codelia"',
		);
		expect(metadataYaml).toContain('agent_display_name: "Codelia CLI"');
		expect(metadataYaml).toContain('agent_org_display_name: "Codelia"');
		expect(metadataYaml).toContain("models:");
		expect(metadataYaml).toContain('model_name: "gpt-5.3-codex"');
		expect(metadataYaml).toContain('model_provider: "openai"');
		expect(metadataYaml).toContain('model_org_display_name: "OpenAI"');
		expect(metadataYaml).not.toContain("agent_name:");
		expect(metadataYaml).not.toContain('model_name: "openai/gpt-5.3-codex"');
	});

	test("warns on aggregate per-task trial counts and does not warn on retries alone", async () => {
		const tempRoot = await createTempDir();
		const jobsRoot = path.join(tempRoot, "jobs");
		const outDir = path.join(tempRoot, "out");
		await mkdir(jobsRoot, { recursive: true });

		const jobs = await Promise.all(
			Array.from({ length: 2 }, (_, index) =>
				createJob({
					jobsRoot,
					jobName: `job-${index + 1}`,
					taskName: "distribution-search",
					suffix: `trial${index + 1}`,
					maxRetries: 2,
				}),
			),
		);

		const result = await packageSubmission({
			jobs,
			outDir,
			benchmark: "terminal-bench",
			version: "2.0",
			agentName: "Codelia",
			agentDisplayName: "Codelia",
			agentOrgDisplayName: "Codelia",
			agentUrl: "https://github.com/kousw/codelia",
			modelName: undefined,
			modelProvider: undefined,
			modelDisplayName: undefined,
			modelOrgDisplayName: undefined,
			notes: "",
		});

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("task distribution-search");
		expect(result.warnings[0]).toContain("2 completed trial(s)");
		expect(result.warnings[0]).not.toContain("max_retries");
	});

	test("validateJobConfig only flags published leaderboard constraints", () => {
		expect(
			validateJobConfig(
				{
					timeout_multiplier: 1.0,
					orchestrator: { retry: { max_retries: 2 } },
					environment: {
						override_cpus: null,
						override_memory_mb: null,
						override_storage_mb: null,
					},
					verifier: {
						override_timeout_sec: null,
						max_timeout_sec: null,
					},
					agents: [
						{
							override_timeout_sec: null,
							max_timeout_sec: null,
						},
					],
				},
				"/tmp/job",
			),
		).toEqual([]);
	});
});
