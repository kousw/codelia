#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SCOPES = new Set(["failed", "timeout", "error"]);

const nowStamp = () =>
  new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-")
    .replaceAll("Z", "");

const parseArgs = (argv) => {
  const out = {
    jobDir: "",
    scope: "failed",
    evalKey: undefined,
    outputConfigPath: undefined,
    jobName: undefined,
    jobsDir: undefined,
    execute: false,
    harborArgs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--") {
      out.harborArgs = argv.slice(i + 1);
      break;
    }
    if (arg === "--job") {
      out.jobDir = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--job=")) {
      out.jobDir = arg.slice("--job=".length);
      continue;
    }
    if (arg === "--scope") {
      out.scope = (next ?? "").toLowerCase();
      i += 1;
      continue;
    }
    if (arg.startsWith("--scope=")) {
      out.scope = arg.slice("--scope=".length).toLowerCase();
      continue;
    }
    if (arg === "--eval-key") {
      out.evalKey = next ?? undefined;
      i += 1;
      continue;
    }
    if (arg.startsWith("--eval-key=")) {
      out.evalKey = arg.slice("--eval-key=".length);
      continue;
    }
    if (arg === "--output-config") {
      out.outputConfigPath = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--output-config=")) {
      out.outputConfigPath = arg.slice("--output-config=".length);
      continue;
    }
    if (arg === "--job-name") {
      out.jobName = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--job-name=")) {
      out.jobName = arg.slice("--job-name=".length);
      continue;
    }
    if (arg === "--jobs-dir") {
      out.jobsDir = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--jobs-dir=")) {
      out.jobsDir = arg.slice("--jobs-dir=".length);
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

  if (!out.jobDir || !out.jobDir.trim()) {
    throw new Error("--job is required");
  }
  if (!SUPPORTED_SCOPES.has(out.scope)) {
    throw new Error("--scope must be one of: failed|timeout|error");
  }

  out.jobDir = path.resolve(out.jobDir.trim());
  if (out.outputConfigPath) {
    out.outputConfigPath = path.resolve(out.outputConfigPath);
  }
  if (out.jobsDir?.trim()) {
    out.jobsDir = path.resolve(out.jobsDir.trim());
  } else {
    out.jobsDir = undefined;
  }
  if (out.jobName && !out.jobName.trim()) {
    out.jobName = undefined;
  }

  return out;
};

const printHelp = () => {
  console.log(
    "usage: rerun-subset.mjs --job <jobDir> [--scope failed|timeout|error] [options] [-- <extra harbor args>]",
  );
  console.log("");
  console.log("options:");
  console.log("  --job <path>            Previous Harbor job directory (contains config.json/result.json)");
  console.log("  --scope <name>          failed|timeout|error (default: failed)");
  console.log("  --eval-key <key>        Explicit eval key in result.json (default: first eval key)");
  console.log("  --output-config <path>  Path to write generated rerun config");
  console.log("  --job-name <name>       Override rerun job name");
  console.log("  --jobs-dir <path>       Override jobs_dir in generated config");
  console.log("  --execute               Run `harbor run -c <generated-config>` immediately");
  console.log("  -h, --help              Show help");
  console.log("");
  console.log("examples:");
  console.log("  node tools/terminal-bench/scripts/rerun-subset.mjs --job tmp/terminal-bench/jobs/2026-02-26__03-50-12 --scope failed");
  console.log(
    "  node tools/terminal-bench/scripts/rerun-subset.mjs --job tmp/terminal-bench/jobs/2026-02-26__03-50-12 --scope timeout --execute -- -n 2 -k 5",
  );
};

const loadJson = async (filePath) => {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
};

const chooseEvalKey = (result, preferredKey) => {
  const evals = result?.stats?.evals;
  if (!evals || typeof evals !== "object") {
    throw new Error("result.json does not contain stats.evals");
  }
  const keys = Object.keys(evals);
  if (keys.length === 0) {
    throw new Error("result.json stats.evals is empty");
  }
  if (preferredKey) {
    if (!keys.includes(preferredKey)) {
      throw new Error(`eval key not found: ${preferredKey}`);
    }
    return preferredKey;
  }
  return keys[0];
};

const trialToTaskName = (trialName) => {
  if (typeof trialName !== "string") return "";
  const idx = trialName.indexOf("__");
  if (idx <= 0) return trialName.trim();
  return trialName.slice(0, idx).trim();
};

const uniqSorted = (items) =>
  [...new Set(items.filter((item) => typeof item === "string" && item.trim().length > 0))]
    .sort((a, b) => a.localeCompare(b));

const selectTrialsByScope = (evalStats, scope) => {
  if (scope === "failed") {
    return evalStats?.reward_stats?.reward?.["0.0"] ?? [];
  }
  if (scope === "timeout") {
    return evalStats?.exception_stats?.AgentTimeoutError ?? [];
  }
  if (scope === "error") {
    const stats = evalStats?.exception_stats;
    if (!stats || typeof stats !== "object") return [];
    return Object.values(stats).flatMap((value) => (Array.isArray(value) ? value : []));
  }
  return [];
};

const buildRerunConfig = (originalConfig, taskNames, { jobName, jobsDir }) => {
  const rerunConfig = JSON.parse(JSON.stringify(originalConfig));

  if (!Array.isArray(rerunConfig.datasets) || rerunConfig.datasets.length === 0) {
    throw new Error("config.json does not contain datasets");
  }

  for (const dataset of rerunConfig.datasets) {
    dataset.task_names = taskNames;
    dataset.exclude_task_names = null;
    dataset.n_tasks = null;
  }

  rerunConfig.tasks = [];
  rerunConfig.job_name = jobName;
  if (jobsDir) {
    rerunConfig.jobs_dir = jobsDir;
  }
  return rerunConfig;
};

const runHarbor = (configPath, extraArgs) =>
  new Promise((resolve, reject) => {
    const args = ["run", "-c", configPath, ...extraArgs];
    const child = spawn("harbor", args, {
      stdio: "inherit",
    });
    child.on("error", (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(typeof code === "number" ? code : 1);
    });
  });

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const configPath = path.join(options.jobDir, "config.json");
  const resultPath = path.join(options.jobDir, "result.json");
  const [config, result] = await Promise.all([loadJson(configPath), loadJson(resultPath)]);

  const evalKey = chooseEvalKey(result, options.evalKey);
  const evalStats = result.stats.evals[evalKey];
  const selectedTrials = selectTrialsByScope(evalStats, options.scope);
  const taskNames = uniqSorted(selectedTrials.map(trialToTaskName));

  if (taskNames.length === 0) {
    throw new Error(
      `no tasks matched scope='${options.scope}' (eval='${evalKey}') in ${resultPath}`,
    );
  }

  const generatedJobName =
    options.jobName ??
    `${path.basename(options.jobDir)}__rerun_${options.scope}__${nowStamp()}`;
  const outputConfigPath =
    options.outputConfigPath ??
    path.join(options.jobDir, "rerun", `${generatedJobName}.config.json`);

  await mkdir(path.dirname(outputConfigPath), { recursive: true });
  const rerunConfig = buildRerunConfig(config, taskNames, {
    jobName: generatedJobName,
    jobsDir: options.jobsDir,
  });
  await writeFile(outputConfigPath, `${JSON.stringify(rerunConfig, null, 2)}\n`, "utf8");

  console.log(`[rerun-subset] source job: ${options.jobDir}`);
  console.log(`[rerun-subset] scope: ${options.scope}`);
  console.log(`[rerun-subset] eval key: ${evalKey}`);
  console.log(`[rerun-subset] matched tasks: ${taskNames.length}`);
  for (const taskName of taskNames) {
    console.log(`- ${taskName}`);
  }
  console.log(`[rerun-subset] generated config: ${outputConfigPath}`);

  const commandPreview = ["harbor", "run", "-c", outputConfigPath, ...options.harborArgs].join(
    " ",
  );
  if (!options.execute) {
    console.log(`[rerun-subset] run with: ${commandPreview}`);
    return 0;
  }

  console.error(`[rerun-subset] executing: ${commandPreview}`);
  return runHarbor(outputConfigPath, options.harborArgs);
};

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      `[rerun-subset] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
