#!/usr/bin/env node

import { mkdir, readFile, writeFile, cp, access } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUT_DIR = path.resolve("tmp/terminal-bench/submissions");

const parseArgs = (argv) => {
  const out = {
    jobs: [],
    outDir: DEFAULT_OUT_DIR,
    benchmark: "terminal-bench",
    version: "2.0",
    agentName: "Codelia",
    modelName: "openai/gpt-5.3-codex",
    agentDisplayName: "Codelia",
    agentUrl: "",
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
    if (arg === "--model-name") {
      out.modelName = next ?? out.modelName;
      i += 1;
      continue;
    }
    if (arg.startsWith("--model-name=")) {
      out.modelName = arg.slice("--model-name=".length);
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
    if (arg === "--agent-url") {
      out.agentUrl = next ?? out.agentUrl;
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent-url=")) {
      out.agentUrl = arg.slice("--agent-url=".length);
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
  if (!out.agentUrl || out.agentUrl.trim().length === 0) {
    throw new Error("--agent-url is required");
  }

  return out;
};

const printHelp = () => {
  console.log("usage: package-submission.mjs --job <jobDir> [--job <jobDir> ...] --agent-url <url> [options]");
  console.log("");
  console.log("options:");
  console.log("  --out-dir <path>                 default: tmp/terminal-bench/submissions");
  console.log("  --benchmark <name>              default: terminal-bench");
  console.log("  --version <version>             default: 2.0");
  console.log("  --agent-name <name>             default: codelia");
  console.log("  --model-name <provider/model>   default: openai/gpt-5.3-codex");
  console.log("  --agent-display-name <text>     default: Codelia");
  console.log("  --agent-url <url>               required");
  console.log("  --notes <text>");
};

const loadJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const toSubmissionDirName = (agentName, modelName) => {
  const safe = `${agentName}__${modelName}`.replaceAll("/", "-").replaceAll(" ", "-");
  return safe;
};

const validateJobConfig = (jobConfig, jobDir) => {
  const issues = [];
  const env = jobConfig.environment ?? {};
  const orchestrator = jobConfig.orchestrator ?? {};

  if (env.override_cpus != null || env.override_memory_mb != null || env.override_storage_mb != null) {
    issues.push(`[warn] ${jobDir}: resource override fields are set; leaderboard may reject this run.`);
  }

  if (Number(orchestrator?.retry?.max_retries ?? 0) !== 0) {
    issues.push(`[warn] ${jobDir}: max_retries is not 0 (${String(orchestrator?.retry?.max_retries)}).`);
  }

  if (Number(jobConfig.n_attempts ?? 1) < 5) {
    issues.push(`[warn] ${jobDir}: n_attempts=${String(jobConfig.n_attempts)} (<5). leaderboard usually expects at least 5 attempts.`);
  }

  return issues;
};

const ensureExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const submissionDir = path.join(
    options.outDir,
    "submissions",
    options.benchmark,
    options.version,
    toSubmissionDirName(options.agentName, options.modelName),
  );

  await mkdir(submissionDir, { recursive: true });

  const warnings = [];

  for (const jobDir of options.jobs) {
    const jobName = path.basename(jobDir);
    const jobConfigPath = path.join(jobDir, "config.json");
    const jobResultPath = path.join(jobDir, "result.json");

    if (!(await ensureExists(jobConfigPath))) {
      throw new Error(`missing job config: ${jobConfigPath}`);
    }

    const jobConfig = await loadJson(jobConfigPath);
    warnings.push(...validateJobConfig(jobConfig, jobDir));

    if (!(await ensureExists(jobResultPath))) {
      warnings.push(`[warn] ${jobDir}: result.json is missing (job may still be running).`);
    } else {
      const jobResult = await loadJson(jobResultPath);
      if (!jobResult.finished_at) {
        warnings.push(`[warn] ${jobDir}: finished_at is null (job may still be running).`);
      }
    }

    const targetJobDir = path.join(submissionDir, jobName);
    await cp(jobDir, targetJobDir, { recursive: true, force: true });
  }

  const metadata = {
    benchmark: options.benchmark,
    version: options.version,
    agent_name: options.agentName,
    agent_display_name: options.agentDisplayName,
    agent_url: options.agentUrl,
    model_name: options.modelName,
    notes: options.notes,
    packaged_at_utc: new Date().toISOString(),
    source_jobs: options.jobs.map((p) => path.basename(p)),
  };

  const metadataYaml = [
    `benchmark: ${metadata.benchmark}`,
    `version: "${metadata.version}"`,
    `agent_name: ${metadata.agent_name}`,
    `agent_display_name: "${metadata.agent_display_name.replaceAll('"', '\\"')}"`,
    `agent_url: "${metadata.agent_url.replaceAll('"', '\\"')}"`,
    `model_name: "${metadata.model_name.replaceAll('"', '\\"')}"`,
    `packaged_at_utc: "${metadata.packaged_at_utc}"`,
    "source_jobs:",
    ...metadata.source_jobs.map((name) => `  - "${name}"`),
    `notes: "${metadata.notes.replaceAll('"', '\\"')}"`,
    "",
  ].join("\n");

  await writeFile(path.join(submissionDir, "metadata.yaml"), metadataYaml, "utf8");
  await writeFile(path.join(submissionDir, "packaging-summary.json"), `${JSON.stringify({ metadata, warnings }, null, 2)}\n`, "utf8");

  console.log(`[terminal-bench] submission package: ${submissionDir}`);
  if (warnings.length > 0) {
    console.error("[terminal-bench] warnings:");
    for (const warning of warnings) {
      console.error(`  - ${warning}`);
    }
  }
};

run().catch((error) => {
  console.error(`[terminal-bench] packaging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
