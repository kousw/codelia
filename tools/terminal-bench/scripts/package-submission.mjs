#!/usr/bin/env node

import {
	access,
	cp,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

export const DEFAULT_OUT_DIR = path.resolve("tmp/terminal-bench/submissions");

const DEFAULT_MODEL_ORG_DISPLAY_NAMES = {
	anthropic: "Anthropic",
	cohere: "Cohere",
	gemini: "Google",
	google: "Google",
	meta: "Meta",
	mistral: "Mistral AI",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	xai: "xAI",
};

const normalizeText = (value) =>
	typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;

const quoteYamlString = (value) =>
	`"${String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("\n", "\\n")}"`;

export const parseArgs = (argv) => {
	const out = {
		jobs: [],
		outDir: DEFAULT_OUT_DIR,
		benchmark: "terminal-bench",
		version: "2.0",
		agentName: "Codelia",
		agentDisplayName: "Codelia",
		agentOrgDisplayName: "Codelia",
		agentUrl: "",
		modelName: undefined,
		modelProvider: undefined,
		modelDisplayName: undefined,
		modelOrgDisplayName: undefined,
		notes: "",
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = argv[i + 1];

		if (arg === "--job") {
			if (!next) throw new Error("--job requires a value");
			out.jobs.push(path.resolve(next));
			i += 1;
			continue;
		}
		if (arg.startsWith("--job=")) {
			out.jobs.push(path.resolve(arg.slice("--job=".length)));
			continue;
		}
		if (arg === "--out-dir") {
			out.outDir = path.resolve(next ?? "");
			i += 1;
			continue;
		}
		if (arg.startsWith("--out-dir=")) {
			out.outDir = path.resolve(arg.slice("--out-dir=".length));
			continue;
		}
		if (arg === "--benchmark") {
			out.benchmark = next ?? out.benchmark;
			i += 1;
			continue;
		}
		if (arg.startsWith("--benchmark=")) {
			out.benchmark = arg.slice("--benchmark=".length);
			continue;
		}
		if (arg === "--version") {
			out.version = next ?? out.version;
			i += 1;
			continue;
		}
		if (arg.startsWith("--version=")) {
			out.version = arg.slice("--version=".length);
			continue;
		}
		if (arg === "--agent-name") {
			out.agentName = next ?? out.agentName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent-name=")) {
			out.agentName = arg.slice("--agent-name=".length);
			continue;
		}
		if (arg === "--agent-display-name") {
			out.agentDisplayName = next ?? out.agentDisplayName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent-display-name=")) {
			out.agentDisplayName = arg.slice("--agent-display-name=".length);
			continue;
		}
		if (arg === "--agent-org-display-name") {
			out.agentOrgDisplayName = next ?? out.agentOrgDisplayName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent-org-display-name=")) {
			out.agentOrgDisplayName = arg.slice("--agent-org-display-name=".length);
			continue;
		}
		if (arg === "--agent-url") {
			out.agentUrl = next ?? out.agentUrl;
			i += 1;
			continue;
		}
		if (arg.startsWith("--agent-url=")) {
			out.agentUrl = arg.slice("--agent-url=".length);
			continue;
		}
		if (arg === "--model-name") {
			out.modelName = next ?? out.modelName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model-name=")) {
			out.modelName = arg.slice("--model-name=".length);
			continue;
		}
		if (arg === "--model-provider") {
			out.modelProvider = next ?? out.modelProvider;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model-provider=")) {
			out.modelProvider = arg.slice("--model-provider=".length);
			continue;
		}
		if (arg === "--model-display-name") {
			out.modelDisplayName = next ?? out.modelDisplayName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model-display-name=")) {
			out.modelDisplayName = arg.slice("--model-display-name=".length);
			continue;
		}
		if (arg === "--model-org-display-name") {
			out.modelOrgDisplayName = next ?? out.modelOrgDisplayName;
			i += 1;
			continue;
		}
		if (arg.startsWith("--model-org-display-name=")) {
			out.modelOrgDisplayName = arg.slice("--model-org-display-name=".length);
			continue;
		}
		if (arg === "--notes") {
			out.notes = next ?? out.notes;
			i += 1;
			continue;
		}
		if (arg.startsWith("--notes=")) {
			out.notes = arg.slice("--notes=".length);
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			printHelp();
			process.exit(0);
		}
	}

	if (out.jobs.length === 0) {
		throw new Error("at least one --job <jobs/<timestamp>> is required");
	}
	if (!normalizeText(out.agentUrl)) {
		throw new Error("--agent-url is required");
	}

	return out;
};

const printHelp = () => {
	console.log(
		"usage: package-submission.mjs --job <jobDir> [--job <jobDir> ...] --agent-url <url> [options]",
	);
	console.log("");
	console.log("options:");
	console.log(
		"  --out-dir <path>                    default: tmp/terminal-bench/submissions",
	);
	console.log("  --benchmark <name>                 default: terminal-bench");
	console.log("  --version <version>                default: 2.0");
	console.log("  --agent-name <name>                default: Codelia");
	console.log("  --agent-display-name <text>        default: Codelia");
	console.log("  --agent-org-display-name <text>    default: Codelia");
	console.log("  --agent-url <url>                  required");
	console.log(
		"  --model-name <provider/model|id>   optional metadata override",
	);
	console.log(
		"  --model-provider <provider>        optional with --model-name",
	);
	console.log(
		"  --model-display-name <text>        optional metadata override",
	);
	console.log(
		"  --model-org-display-name <text>    optional metadata override",
	);
	console.log(
		"  --notes <text>                     stored in packaging-summary.json",
	);
};

export const loadJson = async (filePath) =>
	JSON.parse(await readFile(filePath, "utf8"));

const normalizeModelRecord = (modelProvider, modelName) => {
	const provider = normalizeText(modelProvider)?.toLowerCase();
	const name = normalizeText(modelName);
	if (!provider || !name) return null;
	return { model_name: name, model_provider: provider };
};

export const parseModelSelector = (rawModelName, rawModelProvider) => {
	const modelName = normalizeText(rawModelName);
	const explicitProvider = normalizeText(rawModelProvider)?.toLowerCase();
	if (!modelName && !explicitProvider) return null;
	if (!modelName) {
		throw new Error("--model-provider requires --model-name");
	}

	const slashIndex = modelName.indexOf("/");
	if (slashIndex >= 0) {
		const inferredProvider = modelName
			.slice(0, slashIndex)
			.trim()
			.toLowerCase();
		const inferredName = modelName.slice(slashIndex + 1).trim();
		if (!inferredProvider || !inferredName) {
			throw new Error(`invalid model selector: ${modelName}`);
		}
		if (explicitProvider && explicitProvider !== inferredProvider) {
			throw new Error(
				`--model-provider=${explicitProvider} conflicts with --model-name=${modelName}`,
			);
		}
		return normalizeModelRecord(inferredProvider, inferredName);
	}

	if (!explicitProvider) {
		throw new Error(
			"--model-name without provider must be paired with --model-provider",
		);
	}
	return normalizeModelRecord(explicitProvider, modelName);
};

export const toSubmissionDirName = (agentName, modelSlug) => {
	const safe = `${agentName}__${modelSlug}`
		.replaceAll("/", "-")
		.replaceAll(" ", "-");
	return safe;
};

export const validateJobConfig = (jobConfig, jobDir) => {
	const issues = [];
	const env = jobConfig.environment ?? {};
	const agents = Array.isArray(jobConfig.agents) ? jobConfig.agents : [];
	const verifier = jobConfig.verifier ?? {};

	if (Number(jobConfig.timeout_multiplier ?? 1) !== 1.0) {
		issues.push(
			`[warn] ${jobDir}: timeout_multiplier=${String(jobConfig.timeout_multiplier)} (leaderboard requires 1.0).`,
		);
	}

	if (
		env.override_cpus != null ||
		env.override_memory_mb != null ||
		env.override_storage_mb != null
	) {
		issues.push(
			`[warn] ${jobDir}: resource override fields are set; leaderboard validation may reject this run.`,
		);
	}

	for (const agent of agents) {
		if (agent?.override_timeout_sec != null || agent?.max_timeout_sec != null) {
			issues.push(
				`[warn] ${jobDir}: agent timeout overrides are set; leaderboard validation requires them to be unset.`,
			);
			break;
		}
	}

	if (
		verifier.override_timeout_sec != null ||
		verifier.max_timeout_sec != null
	) {
		issues.push(
			`[warn] ${jobDir}: verifier timeout overrides are set; leaderboard validation requires them to be unset.`,
		);
	}

	return issues;
};

export const ensureExists = async (filePath) => {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
};

const resolveTaskName = (trialResult, fallbackName) =>
	normalizeText(trialResult?.task_name) ??
	normalizeText(trialResult?.task_id?.path) ??
	normalizeText(fallbackName)?.split("__")[0] ??
	"unknown-task";

export const resolveModelFromTrialResult = (trialResult) => {
	const fromAgentInfo = normalizeModelRecord(
		trialResult?.agent_info?.model_info?.provider,
		trialResult?.agent_info?.model_info?.name,
	);
	if (fromAgentInfo) return fromAgentInfo;

	const fromAgentConfig = parseModelSelector(
		trialResult?.config?.agent?.model_name,
		undefined,
	);
	if (fromAgentConfig) return fromAgentConfig;

	const fromMetadata = parseModelSelector(
		trialResult?.agent_result?.metadata?.model_name,
		undefined,
	);
	return fromMetadata;
};

export const collectTrialInfos = async (jobDir) => {
	const entries = await readdir(jobDir, { withFileTypes: true });
	const trials = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const trialDir = path.join(jobDir, entry.name);
		const resultPath = path.join(trialDir, "result.json");
		if (!(await ensureExists(resultPath))) continue;
		const result = await loadJson(resultPath);
		trials.push({
			trial_dir: trialDir,
			trial_name: entry.name,
			task_name: resolveTaskName(result, entry.name),
			finished_at: normalizeText(result?.finished_at) ?? null,
			model: resolveModelFromTrialResult(result),
		});
	}

	return trials;
};

const addModelMapEntry = (modelMap, model) => {
	if (!model) return;
	modelMap.set(`${model.model_provider}/${model.model_name}`, model);
};

export const buildSubmissionMetadata = (options, models) => {
	if (models.length === 0) {
		throw new Error(
			"unable to resolve any model metadata from packaged jobs; pass --model-provider/--model-name to override",
		);
	}
	if (
		models.length > 1 &&
		(normalizeText(options.modelDisplayName) ||
			normalizeText(options.modelOrgDisplayName))
	) {
		throw new Error(
			"--model-display-name and --model-org-display-name only support single-model submissions",
		);
	}

	return {
		agent_url: normalizeText(options.agentUrl),
		agent_display_name:
			normalizeText(options.agentDisplayName) ??
			normalizeText(options.agentName),
		agent_org_display_name:
			normalizeText(options.agentOrgDisplayName) ??
			normalizeText(options.agentDisplayName) ??
			normalizeText(options.agentName),
		models: models.map((model) => ({
			model_name: model.model_name,
			model_provider: model.model_provider,
			model_display_name:
				normalizeText(options.modelDisplayName) ?? model.model_name,
			model_org_display_name:
				normalizeText(options.modelOrgDisplayName) ??
				DEFAULT_MODEL_ORG_DISPLAY_NAMES[model.model_provider] ??
				model.model_provider,
		})),
	};
};

export const formatMetadataYaml = (metadata) =>
	[
		`agent_url: ${quoteYamlString(metadata.agent_url)}`,
		`agent_display_name: ${quoteYamlString(metadata.agent_display_name)}`,
		`agent_org_display_name: ${quoteYamlString(metadata.agent_org_display_name)}`,
		"models:",
		...metadata.models.flatMap((model) => [
			`  - model_name: ${quoteYamlString(model.model_name)}`,
			`    model_provider: ${quoteYamlString(model.model_provider)}`,
			`    model_display_name: ${quoteYamlString(model.model_display_name)}`,
			`    model_org_display_name: ${quoteYamlString(model.model_org_display_name)}`,
		]),
		"",
	].join("\n");

const buildModelSlug = (models, explicitModel) => {
	if (explicitModel) {
		return `${explicitModel.model_provider}/${explicitModel.model_name}`;
	}
	return models
		.map((model) => `${model.model_provider}/${model.model_name}`)
		.join("+");
};

const compareModels = (left, right) =>
	left.model_provider.localeCompare(right.model_provider) ||
	left.model_name.localeCompare(right.model_name);

export const packageSubmission = async (options) => {
	const warnings = [];
	const taskTrialCounts = new Map();
	const trialInfos = [];
	const derivedModelMap = new Map();

	for (const jobDir of options.jobs) {
		const jobConfigPath = path.join(jobDir, "config.json");
		const jobResultPath = path.join(jobDir, "result.json");

		if (!(await ensureExists(jobConfigPath))) {
			throw new Error(`missing job config: ${jobConfigPath}`);
		}

		const jobConfig = await loadJson(jobConfigPath);
		warnings.push(...validateJobConfig(jobConfig, jobDir));

		if (!(await ensureExists(jobResultPath))) {
			warnings.push(
				`[warn] ${jobDir}: result.json is missing (job may still be running).`,
			);
		} else {
			const jobResult = await loadJson(jobResultPath);
			if (!normalizeText(jobResult.finished_at)) {
				warnings.push(
					`[warn] ${jobDir}: result.json finished_at is null (job may still be running).`,
				);
			}
		}

		const trials = await collectTrialInfos(jobDir);
		if (trials.length === 0) {
			warnings.push(
				`[warn] ${jobDir}: no trial result.json files were found under the job directory.`,
			);
		}

		for (const trial of trials) {
			trialInfos.push(trial);
			addModelMapEntry(derivedModelMap, trial.model);
			if (!trial.finished_at) {
				warnings.push(
					`[warn] ${trial.trial_dir}: result.json finished_at is null (trial may still be running).`,
				);
				continue;
			}
			taskTrialCounts.set(
				trial.task_name,
				(taskTrialCounts.get(trial.task_name) ?? 0) + 1,
			);
		}
	}

	const explicitModel = parseModelSelector(
		options.modelName,
		options.modelProvider,
	);
	if (explicitModel && derivedModelMap.size > 0) {
		const derivedKeys = new Set(derivedModelMap.keys());
		if (
			derivedKeys.size !== 1 ||
			!derivedKeys.has(
				`${explicitModel.model_provider}/${explicitModel.model_name}`,
			)
		) {
			throw new Error(
				"explicit model metadata does not match the model(s) detected from packaged trial results",
			);
		}
	}

	const models = explicitModel
		? [explicitModel]
		: Array.from(derivedModelMap.values()).sort(compareModels);
	const metadata = buildSubmissionMetadata(options, models);
	const modelSlug = buildModelSlug(models, explicitModel);
	const submissionDir = path.join(
		options.outDir,
		"submissions",
		options.benchmark,
		options.version,
		toSubmissionDirName(options.agentName, modelSlug),
	);

	await mkdir(submissionDir, { recursive: true });

	for (const jobDir of options.jobs) {
		const jobName = path.basename(jobDir);
		const targetJobDir = path.join(submissionDir, jobName);
		await cp(jobDir, targetJobDir, { recursive: true, force: true });
	}

	for (const [taskName, trialCount] of [...taskTrialCounts.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		if (trialCount < 5) {
			warnings.push(
				`[warn] task ${taskName}: only ${trialCount} completed trial(s) were found across packaged jobs (<5 required by leaderboard).`,
			);
		}
	}

	await writeFile(
		path.join(submissionDir, "metadata.yaml"),
		formatMetadataYaml(metadata),
		"utf8",
	);
	await writeFile(
		path.join(submissionDir, "packaging-summary.json"),
		`${JSON.stringify(
			{
				metadata,
				warnings,
				source_jobs: options.jobs.map((jobDir) => path.basename(jobDir)),
				task_trial_counts: Object.fromEntries(
					[...taskTrialCounts.entries()].sort(([left], [right]) =>
						left.localeCompare(right),
					),
				),
				notes: options.notes,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	return {
		submissionDir,
		warnings,
		metadata,
		taskTrialCounts,
		trialInfos,
	};
};

const runCli = async () => {
	const options = parseArgs(process.argv.slice(2));
	const result = await packageSubmission(options);

	console.log(`[terminal-bench] submission package: ${result.submissionDir}`);
	if (result.warnings.length > 0) {
		console.error("[terminal-bench] warnings:");
		for (const warning of result.warnings) {
			console.error(`  - ${warning}`);
		}
	}
};

if (import.meta.main) {
	runCli().catch((error) => {
		console.error(
			`[terminal-bench] packaging failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	});
}
