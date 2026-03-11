#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
	jobsDir: path.resolve("tmp/terminal-bench/jobs"),
	limit: 12,
	minRuns: 3,
	minSuccessRate: 0.25,
	maxSuccessRate: 0.85,
	targetSuccessRate: 0.6,
	maxMeanTotalSec: 7 * 60,
	maxTimeouts: 1,
};

const nowStamp = () =>
	new Date()
		.toISOString()
		.replaceAll(":", "-")
		.replaceAll(".", "-")
		.replaceAll("Z", "");

const printHelp = () => {
	console.log(
		"usage: quick-subset.mjs [--jobs-dir <path>] [options] [-- <extra harbor args>]",
	);
	console.log("");
	console.log("options:");
	console.log(
		"  --jobs-dir <path>            Harbor jobs directory (default: tmp/terminal-bench/jobs)",
	);
	console.log(
		"  --base-job <path>            Base Harbor job directory for generated config (default: latest job with config/result)",
	);
	console.log(
		"  --limit <n>                  Number of tasks to select (default: 12)",
	);
	console.log(
		"  --min-runs <n>               Minimum historical runs per task (default: 3)",
	);
	console.log(
		"  --min-success-rate <0..1>    Minimum mean success rate (default: 0.25)",
	);
	console.log(
		"  --max-success-rate <0..1>    Maximum mean success rate (default: 0.85)",
	);
	console.log(
		"  --target-success-rate <0..1> Target mean success rate for ranking (default: 0.6)",
	);
	console.log(
		"  --max-mean-total-sec <n>     Maximum mean total trial duration in seconds (default: 420)",
	);
	console.log(
		"  --max-timeouts <n>           Maximum historical timeout count per task (default: 1)",
	);
	console.log(
		"  --debug <true|false>         Override Harbor debug flag in generated config",
	);
	console.log(
		"  --n-concurrent-trials <n>    Override orchestrator.n_concurrent_trials",
	);
	console.log("  --attempts <n>               Override top-level n_attempts");
	console.log(
		"  --retries <n>                Override orchestrator.retry.max_retries",
	);
	console.log(
		"  --agent-import-path <path>   Override the generated config agent import path",
	);
	console.log(
		"  --model <provider/name>      Override the generated config model_name",
	);
	console.log(
		"  --approval-mode <mode>       Override agent kwargs approval_mode",
	);
	console.log("  --auth-file <path>           Override agent kwargs auth_file");
	console.log(
		"  --system-prompt-file <path>  Override agent kwargs system_prompt_file",
	);
	console.log("  --reasoning <level>          Override agent kwargs reasoning");
	console.log(
		"  --experimental-openai-websocket-mode <mode>  Override agent websocket mode",
	);
	console.log(
		"  --prompt-progress-stderr <mode> Override agent kwargs prompt_progress_stderr",
	);
	console.log(
		"  --output-config <path>       Path to write generated Harbor config",
	);
	console.log(
		"  --job-name <name>            Override generated Harbor job name",
	);
	console.log(
		"  --jobs-output-dir <path>     Override jobs_dir in generated Harbor config",
	);
	console.log(
		"  --execute                    Run `harbor run -c <generated-config>` immediately",
	);
	console.log("  -h, --help                   Show help");
	console.log("");
	console.log("examples:");
	console.log(
		"  node tools/terminal-bench/scripts/quick-subset.mjs --limit 10",
	);
	console.log(
		"  node tools/terminal-bench/scripts/quick-subset.mjs --limit 8 --max-mean-total-sec 300 --attempts 1 --retries 2 --n-concurrent-trials 4 --model openai/gpt-5.3-codex --approval-mode full-access --auth-file '~/.codelia/auth.json' --reasoning high --experimental-openai-websocket-mode on --prompt-progress-stderr on --execute",
	);
};

const parseNumber = (value, label) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${label} must be a finite number`);
	}
	return parsed;
};

const parseRatio = (value, label) => {
	const parsed = parseNumber(value, label);
	if (parsed < 0 || parsed > 1) {
		throw new Error(`${label} must be between 0 and 1`);
	}
	return parsed;
};

const parsePositiveInt = (value, label) => {
	const parsed = Math.trunc(parseNumber(value, label));
	if (parsed <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return parsed;
};

const parseNonNegativeInt = (value, label) => {
	const parsed = Math.trunc(parseNumber(value, label));
	if (parsed < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return parsed;
};

const parseOptionalBool = (value, label) => {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) {
		return true;
	}
	if (["0", "false", "no", "off"].includes(normalized)) {
		return false;
	}
	throw new Error(`${label} must be one of: true|false`);
};

const parseArgs = (argv) => {
	const out = {
		jobsDir: DEFAULTS.jobsDir,
		baseJobDir: undefined,
		limit: DEFAULTS.limit,
		minRuns: DEFAULTS.minRuns,
		minSuccessRate: DEFAULTS.minSuccessRate,
		maxSuccessRate: DEFAULTS.maxSuccessRate,
		targetSuccessRate: DEFAULTS.targetSuccessRate,
		maxMeanTotalSec: DEFAULTS.maxMeanTotalSec,
		maxTimeouts: DEFAULTS.maxTimeouts,
		debug: undefined,
		nConcurrentTrials: undefined,
		attempts: undefined,
		retries: undefined,
		agentImportPath: undefined,
		model: undefined,
		approvalMode: undefined,
		authFile: undefined,
		systemPromptFile: undefined,
		reasoning: undefined,
		experimentalOpenaiWebsocketMode: undefined,
		promptProgressStderr: undefined,
		outputConfigPath: undefined,
		jobName: undefined,
		jobsOutputDir: undefined,
		execute: false,
		harborArgs: [],
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		const next = argv[index + 1];
		if (arg === "--") {
			out.harborArgs = argv.slice(index + 1);
			break;
		}
		if (arg === "--jobs-dir") {
			out.jobsDir = path.resolve(next ?? "");
			index += 1;
			continue;
		}
		if (arg.startsWith("--jobs-dir=")) {
			out.jobsDir = path.resolve(arg.slice("--jobs-dir=".length));
			continue;
		}
		if (arg === "--base-job") {
			out.baseJobDir = path.resolve(next ?? "");
			index += 1;
			continue;
		}
		if (arg.startsWith("--base-job=")) {
			out.baseJobDir = path.resolve(arg.slice("--base-job=".length));
			continue;
		}
		if (arg === "--limit") {
			out.limit = parsePositiveInt(next, "--limit");
			index += 1;
			continue;
		}
		if (arg.startsWith("--limit=")) {
			out.limit = parsePositiveInt(arg.slice("--limit=".length), "--limit");
			continue;
		}
		if (arg === "--min-runs") {
			out.minRuns = parsePositiveInt(next, "--min-runs");
			index += 1;
			continue;
		}
		if (arg.startsWith("--min-runs=")) {
			out.minRuns = parsePositiveInt(
				arg.slice("--min-runs=".length),
				"--min-runs",
			);
			continue;
		}
		if (arg === "--min-success-rate") {
			out.minSuccessRate = parseRatio(next, "--min-success-rate");
			index += 1;
			continue;
		}
		if (arg.startsWith("--min-success-rate=")) {
			out.minSuccessRate = parseRatio(
				arg.slice("--min-success-rate=".length),
				"--min-success-rate",
			);
			continue;
		}
		if (arg === "--max-success-rate") {
			out.maxSuccessRate = parseRatio(next, "--max-success-rate");
			index += 1;
			continue;
		}
		if (arg.startsWith("--max-success-rate=")) {
			out.maxSuccessRate = parseRatio(
				arg.slice("--max-success-rate=".length),
				"--max-success-rate",
			);
			continue;
		}
		if (arg === "--target-success-rate") {
			out.targetSuccessRate = parseRatio(next, "--target-success-rate");
			index += 1;
			continue;
		}
		if (arg.startsWith("--target-success-rate=")) {
			out.targetSuccessRate = parseRatio(
				arg.slice("--target-success-rate=".length),
				"--target-success-rate",
			);
			continue;
		}
		if (arg === "--max-mean-total-sec") {
			out.maxMeanTotalSec = parsePositiveInt(next, "--max-mean-total-sec");
			index += 1;
			continue;
		}
		if (arg.startsWith("--max-mean-total-sec=")) {
			out.maxMeanTotalSec = parsePositiveInt(
				arg.slice("--max-mean-total-sec=".length),
				"--max-mean-total-sec",
			);
			continue;
		}
		if (arg === "--max-timeouts") {
			out.maxTimeouts = parseNonNegativeInt(next, "--max-timeouts");
			index += 1;
			continue;
		}
		if (arg.startsWith("--max-timeouts=")) {
			out.maxTimeouts = parseNonNegativeInt(
				arg.slice("--max-timeouts=".length),
				"--max-timeouts",
			);
			continue;
		}
		if (arg === "--debug") {
			out.debug = parseOptionalBool(next, "--debug");
			index += 1;
			continue;
		}
		if (arg.startsWith("--debug=")) {
			out.debug = parseOptionalBool(arg.slice("--debug=".length), "--debug");
			continue;
		}
		if (arg === "--n-concurrent-trials") {
			out.nConcurrentTrials = parsePositiveInt(next, "--n-concurrent-trials");
			index += 1;
			continue;
		}
		if (arg.startsWith("--n-concurrent-trials=")) {
			out.nConcurrentTrials = parsePositiveInt(
				arg.slice("--n-concurrent-trials=".length),
				"--n-concurrent-trials",
			);
			continue;
		}
		if (arg === "--attempts") {
			out.attempts = parsePositiveInt(next, "--attempts");
			index += 1;
			continue;
		}
		if (arg.startsWith("--attempts=")) {
			out.attempts = parsePositiveInt(
				arg.slice("--attempts=".length),
				"--attempts",
			);
			continue;
		}
		if (arg === "--retries") {
			out.retries = parseNonNegativeInt(next, "--retries");
			index += 1;
			continue;
		}
		if (arg.startsWith("--retries=")) {
			out.retries = parseNonNegativeInt(
				arg.slice("--retries=".length),
				"--retries",
			);
			continue;
		}
		if (arg === "--agent-import-path") {
			out.agentImportPath = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--agent-import-path=")) {
			out.agentImportPath = arg.slice("--agent-import-path=".length);
			continue;
		}
		if (arg === "--model") {
			out.model = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--model=")) {
			out.model = arg.slice("--model=".length);
			continue;
		}
		if (arg === "--approval-mode") {
			out.approvalMode = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--approval-mode=")) {
			out.approvalMode = arg.slice("--approval-mode=".length);
			continue;
		}
		if (arg === "--auth-file") {
			out.authFile = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--auth-file=")) {
			out.authFile = arg.slice("--auth-file=".length);
			continue;
		}
		if (arg === "--system-prompt-file") {
			out.systemPromptFile = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--system-prompt-file=")) {
			out.systemPromptFile = arg.slice("--system-prompt-file=".length);
			continue;
		}
		if (arg === "--reasoning") {
			out.reasoning = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--reasoning=")) {
			out.reasoning = arg.slice("--reasoning=".length);
			continue;
		}
		if (arg === "--experimental-openai-websocket-mode") {
			out.experimentalOpenaiWebsocketMode = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--experimental-openai-websocket-mode=")) {
			out.experimentalOpenaiWebsocketMode = arg.slice(
				"--experimental-openai-websocket-mode=".length,
			);
			continue;
		}
		if (arg === "--prompt-progress-stderr") {
			out.promptProgressStderr = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--prompt-progress-stderr=")) {
			out.promptProgressStderr = arg.slice("--prompt-progress-stderr=".length);
			continue;
		}
		if (arg === "--output-config") {
			out.outputConfigPath = path.resolve(next ?? "");
			index += 1;
			continue;
		}
		if (arg.startsWith("--output-config=")) {
			out.outputConfigPath = path.resolve(arg.slice("--output-config=".length));
			continue;
		}
		if (arg === "--job-name") {
			out.jobName = next ?? "";
			index += 1;
			continue;
		}
		if (arg.startsWith("--job-name=")) {
			out.jobName = arg.slice("--job-name=".length);
			continue;
		}
		if (arg === "--jobs-output-dir") {
			out.jobsOutputDir = path.resolve(next ?? "");
			index += 1;
			continue;
		}
		if (arg.startsWith("--jobs-output-dir=")) {
			out.jobsOutputDir = path.resolve(arg.slice("--jobs-output-dir=".length));
			continue;
		}
		if (arg === "--execute") {
			out.execute = true;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			printHelp();
			process.exit(0);
		}
		throw new Error(`unknown option: ${arg}`);
	}

	if (out.minSuccessRate > out.maxSuccessRate) {
		throw new Error("--min-success-rate must be <= --max-success-rate");
	}

	return out;
};

const loadJson = async (filePath) => {
	const raw = await readFile(filePath, "utf8");
	return JSON.parse(raw);
};

const parseIsoDurationSeconds = (startedAt, finishedAt) => {
	if (!startedAt || !finishedAt) return null;
	const start = Date.parse(startedAt);
	const finish = Date.parse(finishedAt);
	if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
		return null;
	}
	return Math.round((finish - start) / 1000);
};

const mean = (values) =>
	values.reduce((sum, value) => sum + value, 0) / values.length;

const normalizeDatasetsForCompatibility = (datasets) => {
	if (!Array.isArray(datasets)) return [];
	return datasets.map((dataset) => ({
		name: dataset?.name ?? null,
		version: dataset?.version ?? null,
		registryUrl: dataset?.registry?.url ?? null,
		registryName: dataset?.registry?.name ?? null,
		overwrite: dataset?.overwrite ?? null,
		downloadDir: dataset?.download_dir ?? null,
	}));
};

const datasetCompatibilityKey = (config) =>
	JSON.stringify(normalizeDatasetsForCompatibility(config?.datasets));

const chooseBaseJobDir = async (jobsDir, explicitBaseJobDir) => {
	if (explicitBaseJobDir) {
		return explicitBaseJobDir;
	}
	const entries = await readdir(jobsDir, { withFileTypes: true });
	const candidates = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(jobsDir, entry.name))
		.sort((left, right) => right.localeCompare(left));

	for (const candidate of candidates) {
		try {
			await loadJson(path.join(candidate, "config.json"));
			await loadJson(path.join(candidate, "result.json"));
			return candidate;
		} catch {}
	}
	throw new Error(`could not find a usable base job in ${jobsDir}`);
};

const collectTaskStats = async (jobsDir, compatibleDatasetKey) => {
	const entries = await readdir(jobsDir, { withFileTypes: true });
	const taskRows = new Map();
	let scannedJobs = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const jobDir = path.join(jobsDir, entry.name);
		const jobResultPath = path.join(jobDir, "result.json");
		const jobConfigPath = path.join(jobDir, "config.json");
		let jobResult;
		let jobConfig;
		try {
			jobResult = await loadJson(jobResultPath);
			jobConfig = await loadJson(jobConfigPath);
		} catch {
			continue;
		}
		if (
			compatibleDatasetKey &&
			datasetCompatibilityKey(jobConfig) !== compatibleDatasetKey
		) {
			continue;
		}
		if (
			typeof jobResult?.finished_at !== "string" ||
			jobResult.finished_at.trim().length === 0
		) {
			continue;
		}
		if (
			!Number.isFinite(jobResult?.n_total_trials) ||
			jobResult.n_total_trials <= 0
		) {
			continue;
		}
		scannedJobs += 1;
		const trialEntries = await readdir(jobDir, { withFileTypes: true });
		for (const trialEntry of trialEntries) {
			if (!trialEntry.isDirectory()) continue;
			const trialResultPath = path.join(jobDir, trialEntry.name, "result.json");
			let trialResult;
			try {
				trialResult = await loadJson(trialResultPath);
			} catch {
				continue;
			}

			const taskName = trialResult?.task_name;
			if (typeof taskName !== "string" || taskName.trim().length === 0) {
				continue;
			}

			const reward =
				Number(
					trialResult?.verifier_result?.rewards?.reward ??
						trialResult?.verifier_result?.reward ??
						0,
				) || 0;
			const totalSeconds = parseIsoDurationSeconds(
				trialResult?.started_at,
				trialResult?.finished_at,
			);
			const executionSeconds = parseIsoDurationSeconds(
				trialResult?.agent_execution?.started_at,
				trialResult?.agent_execution?.finished_at,
			);
			const exceptionType =
				typeof trialResult?.exception_info?.type === "string"
					? trialResult.exception_info.type
					: null;

			const existing = taskRows.get(taskName) ?? [];
			existing.push({
				reward,
				totalSeconds,
				executionSeconds,
				exceptionType,
				jobName: entry.name,
			});
			taskRows.set(taskName, existing);
		}
	}

	const tasks = [];
	for (const [taskName, rows] of taskRows.entries()) {
		const totalSeconds = rows
			.map((row) => row.totalSeconds)
			.filter((value) => Number.isFinite(value));
		const executionSeconds = rows
			.map((row) => row.executionSeconds)
			.filter((value) => Number.isFinite(value));
		if (totalSeconds.length === 0 || executionSeconds.length === 0) {
			continue;
		}
		const successRate = mean(rows.map((row) => row.reward));
		const timeoutCount = rows.filter(
			(row) => row.exceptionType === "AgentTimeoutError",
		).length;
		tasks.push({
			taskName,
			runs: rows.length,
			successRate,
			meanTotalSeconds: mean(totalSeconds),
			meanExecutionSeconds: mean(executionSeconds),
			timeoutCount,
		});
	}

	return { scannedJobs, tasks };
};

const selectTasks = (tasks, options) => {
	const filtered = tasks.filter(
		(task) =>
			task.runs >= options.minRuns &&
			task.successRate >= options.minSuccessRate &&
			task.successRate <= options.maxSuccessRate &&
			task.meanTotalSeconds <= options.maxMeanTotalSec &&
			task.timeoutCount <= options.maxTimeouts,
	);

	const ranked = [...filtered].sort((left, right) => {
		const leftScore =
			Math.abs(left.successRate - options.targetSuccessRate) * 10 +
			left.meanTotalSeconds / options.maxMeanTotalSec -
			Math.min(left.runs, 10) * 0.03 +
			left.timeoutCount * 0.25;
		const rightScore =
			Math.abs(right.successRate - options.targetSuccessRate) * 10 +
			right.meanTotalSeconds / options.maxMeanTotalSec -
			Math.min(right.runs, 10) * 0.03 +
			right.timeoutCount * 0.25;
		if (leftScore !== rightScore) {
			return leftScore - rightScore;
		}
		if (left.meanTotalSeconds !== right.meanTotalSeconds) {
			return left.meanTotalSeconds - right.meanTotalSeconds;
		}
		if (left.runs !== right.runs) {
			return right.runs - left.runs;
		}
		return left.taskName.localeCompare(right.taskName);
	});

	return {
		filtered,
		selected: ranked.slice(0, options.limit),
	};
};

const buildSubsetConfig = (
	baseConfig,
	taskNames,
	{ jobName, jobsOutputDir },
) => {
	const next = JSON.parse(JSON.stringify(baseConfig));
	if (!Array.isArray(next.datasets) || next.datasets.length === 0) {
		throw new Error("base config does not contain datasets");
	}
	for (const dataset of next.datasets) {
		dataset.task_names = taskNames;
		dataset.exclude_task_names = null;
		dataset.n_tasks = null;
	}
	next.tasks = [];
	next.job_name = jobName;
	if (jobsOutputDir) {
		next.jobs_dir = jobsOutputDir;
	}
	return next;
};

const applyConfigOverrides = (config, options) => {
	if (options.debug !== undefined) {
		config.debug = options.debug;
	}
	if (options.attempts !== undefined) {
		config.n_attempts = options.attempts;
	}
	if (options.nConcurrentTrials !== undefined) {
		config.orchestrator ??= {};
		config.orchestrator.n_concurrent_trials = options.nConcurrentTrials;
	}
	if (options.retries !== undefined) {
		config.orchestrator ??= {};
		config.orchestrator.retry ??= {};
		config.orchestrator.retry.max_retries = options.retries;
	}
	if (Array.isArray(config.agents) && config.agents.length > 0) {
		const agent = config.agents[0];
		agent.kwargs ??= {};
		if (options.agentImportPath) {
			agent.import_path = options.agentImportPath;
		}
		if (options.model) {
			agent.model_name = options.model;
		}
		if (options.approvalMode) {
			agent.kwargs.approval_mode = options.approvalMode;
		}
		if (options.authFile) {
			agent.kwargs.auth_file = options.authFile;
		}
		if (options.systemPromptFile) {
			agent.kwargs.system_prompt_file = options.systemPromptFile;
		}
		if (options.reasoning) {
			agent.kwargs.reasoning = options.reasoning;
		}
		if (options.experimentalOpenaiWebsocketMode) {
			agent.kwargs.experimental_openai_websocket_mode =
				options.experimentalOpenaiWebsocketMode;
		}
		if (options.promptProgressStderr) {
			agent.kwargs.prompt_progress_stderr = options.promptProgressStderr;
		}
	}
	return config;
};

const runHarbor = (configPath, extraArgs) =>
	new Promise((resolve, reject) => {
		const child = spawn("harbor", ["run", "-c", configPath, ...extraArgs], {
			stdio: "inherit",
		});
		child.on("error", (error) =>
			reject(error instanceof Error ? error : new Error(String(error))),
		);
		child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
	});

const run = async () => {
	const options = parseArgs(process.argv.slice(2));
	const baseJobDir = await chooseBaseJobDir(
		options.jobsDir,
		options.baseJobDir,
	);
	const baseConfig = await loadJson(path.join(baseJobDir, "config.json"));
	const compatibleDatasetKey = datasetCompatibilityKey(baseConfig);
	const { scannedJobs, tasks } = await collectTaskStats(
		options.jobsDir,
		compatibleDatasetKey,
	);
	if (tasks.length === 0) {
		throw new Error(
			`no historical task stats found in ${options.jobsDir} for dataset compatible with ${path.basename(baseJobDir)}`,
		);
	}

	const { filtered, selected } = selectTasks(tasks, options);
	if (selected.length === 0) {
		throw new Error(
			"no tasks matched the quick-subset filters; try relaxing success-rate or duration thresholds",
		);
	}
	const generatedJobName =
		options.jobName ??
		`${path.basename(baseJobDir)}__quick_subset__${nowStamp()}`;
	const outputConfigPath =
		options.outputConfigPath ??
		path.join(options.jobsDir, "_generated", `${generatedJobName}.config.json`);
	const taskNames = selected
		.map((task) => task.taskName)
		.sort((a, b) => a.localeCompare(b));

	await mkdir(path.dirname(outputConfigPath), { recursive: true });
	const nextConfig = applyConfigOverrides(
		buildSubsetConfig(baseConfig, taskNames, {
			jobName: generatedJobName,
			jobsOutputDir: options.jobsOutputDir,
		}),
		options,
	);
	await writeFile(
		outputConfigPath,
		`${JSON.stringify(nextConfig, null, 2)}\n`,
		"utf8",
	);

	console.log(`[quick-subset] jobs dir: ${options.jobsDir}`);
	console.log(`[quick-subset] scanned jobs: ${scannedJobs}`);
	console.log(`[quick-subset] tasks with stats: ${tasks.length}`);
	console.log(`[quick-subset] candidate tasks: ${filtered.length}`);
	console.log(`[quick-subset] selected tasks: ${selected.length}`);
	for (const task of selected) {
		console.log(
			`- ${task.taskName} runs=${task.runs} success=${task.successRate.toFixed(2)} mean_total=${Math.round(task.meanTotalSeconds)}s mean_exec=${Math.round(task.meanExecutionSeconds)}s timeouts=${task.timeoutCount}`,
		);
	}
	console.log(`[quick-subset] base job: ${baseJobDir}`);
	if (options.model) {
		console.log(`[quick-subset] model override: ${options.model}`);
	}
	if (options.nConcurrentTrials !== undefined) {
		console.log(
			`[quick-subset] concurrency override: ${options.nConcurrentTrials}`,
		);
	}
	if (options.attempts !== undefined) {
		console.log(`[quick-subset] attempts override: ${options.attempts}`);
	}
	if (options.retries !== undefined) {
		console.log(`[quick-subset] retries override: ${options.retries}`);
	}
	console.log(`[quick-subset] generated config: ${outputConfigPath}`);

	const commandPreview = [
		"harbor",
		"run",
		"-c",
		outputConfigPath,
		...options.harborArgs,
	].join(" ");
	if (!options.execute) {
		console.log(`[quick-subset] run with: ${commandPreview}`);
		return 0;
	}

	console.error(`[quick-subset] executing: ${commandPreview}`);
	return runHarbor(outputConfigPath, options.harborArgs);
};

run()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(
			`[quick-subset] failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
