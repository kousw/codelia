#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const nowIso = () => new Date().toISOString();

const parseArgs = (argv) => {
  const out = {
    prompt: "",
    approvalMode: "full-access",
    artifactsRoot: path.resolve("tmp/terminal-bench"),
    datasetId: "terminal-bench@2.0",
    taskId: undefined,
    modelProvider: undefined,
    modelName: undefined,
    runtimeCmd: process.env.CODELIA_TERMINAL_BENCH_RUNTIME_CMD ?? "bun",
    runtimeArgs:
      process.env.CODELIA_TERMINAL_BENCH_RUNTIME_ARGS ??
      "packages/runtime/src/index.ts",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--prompt") {
      out.prompt = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--prompt=")) {
      out.prompt = arg.slice("--prompt=".length);
      continue;
    }
    if (arg === "--approval-mode") {
      out.approvalMode = next ?? "";
      i += 1;
      continue;
    }
    if (arg.startsWith("--approval-mode=")) {
      out.approvalMode = arg.slice("--approval-mode=".length);
      continue;
    }
    if (arg === "--artifacts-root") {
      out.artifactsRoot = path.resolve(next ?? "");
      i += 1;
      continue;
    }
    if (arg.startsWith("--artifacts-root=")) {
      out.artifactsRoot = path.resolve(arg.slice("--artifacts-root=".length));
      continue;
    }
    if (arg === "--dataset") {
      out.datasetId = next ?? out.datasetId;
      i += 1;
      continue;
    }
    if (arg.startsWith("--dataset=")) {
      out.datasetId = arg.slice("--dataset=".length);
      continue;
    }
    if (arg === "--task-id") {
      out.taskId = next ?? undefined;
      i += 1;
      continue;
    }
    if (arg.startsWith("--task-id=")) {
      out.taskId = arg.slice("--task-id=".length);
      continue;
    }
    if (arg === "--model-provider") {
      out.modelProvider = next ?? undefined;
      i += 1;
      continue;
    }
    if (arg.startsWith("--model-provider=")) {
      out.modelProvider = arg.slice("--model-provider=".length);
      continue;
    }
    if (arg === "--model-name") {
      out.modelName = next ?? undefined;
      i += 1;
      continue;
    }
    if (arg.startsWith("--model-name=")) {
      out.modelName = arg.slice("--model-name=".length);
      continue;
    }
    if (arg === "--runtime-cmd") {
      out.runtimeCmd = next ?? out.runtimeCmd;
      i += 1;
      continue;
    }
    if (arg.startsWith("--runtime-cmd=")) {
      out.runtimeCmd = arg.slice("--runtime-cmd=".length);
      continue;
    }
    if (arg === "--runtime-args") {
      out.runtimeArgs = next ?? out.runtimeArgs;
      i += 1;
      continue;
    }
    if (arg.startsWith("--runtime-args=")) {
      out.runtimeArgs = arg.slice("--runtime-args=".length);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!out.prompt || out.prompt.trim().length === 0) {
    throw new Error("--prompt is required");
  }
  if (!out.approvalMode || out.approvalMode.trim().length === 0) {
    throw new Error("--approval-mode requires a non-empty value");
  }
  const hasProvider = !!(out.modelProvider && out.modelProvider.trim().length > 0);
  const hasName = !!(out.modelName && out.modelName.trim().length > 0);
  if (hasProvider !== hasName) {
    throw new Error("--model-provider and --model-name must be provided together");
  }
  return out;
};

const printHelp = () => {
  console.log("usage: run-benchmark.mjs --prompt <text> [options]");
  console.log("");
  console.log("options:");
  console.log("  --approval-mode <minimal|trusted|full-access>  (default: full-access)");
  console.log("  --artifacts-root <path>                         (default: tmp/terminal-bench)");
  console.log("  --dataset <id>                                  (default: terminal-bench@2.0)");
  console.log("  --task-id <id>");
  console.log("  --model-provider <name>");
  console.log("  --model-name <name>");
  console.log("  --runtime-cmd <cmd>                             (default: bun)");
  console.log("  --runtime-args <args>                           (default: packages/runtime/src/index.ts)");
};

const splitArgs = (value) => {
  const out = [];
  let current = "";
  let quote = null;
  let escaping = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "single") {
      escaping = true;
      continue;
    }
    if (quote === "single") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
};

const buildModelOverrideConfig = (provider, name) => ({
  version: 1,
  model: {
    provider,
    name,
  },
});

const writeModelOverrideConfig = async (runDir, provider, name) => {
  if (!provider || !name) return null;
  const configDir = path.join(runDir, "config");
  await mkdir(configDir, { recursive: true });
  const configPath = path.join(configDir, "benchmark-config.json");
  const config = buildModelOverrideConfig(provider, name);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
};

const resolveStorageSessionsDir = () => {
  const layout = (process.env.CODELIA_LAYOUT ?? "home").toLowerCase();
  const home = os.homedir();
  if (layout === "xdg") {
    const stateRoot = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
    return path.join(stateRoot, "codelia", "sessions");
  }
  return path.join(home, ".codelia", "sessions");
};

const findRunLogFile = async (sessionsDir, runId) => {
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const name = String(entry.name);
      if (name === "messages" || name === "state") continue;
      const absolute = path.join(dir, name);
      if (entry.isDirectory()) {
        const found = await walk(absolute);
        if (found) return found;
        continue;
      }
      if (entry.isFile() && name === `${runId}.jsonl`) {
        return absolute;
      }
    }
    return null;
  };
  return walk(sessionsDir);
};

const parseSessionJsonl = async (filePath) => {
  const raw = await readFile(filePath, "utf8");
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
  return out;
};

const toAtif = (records, runId) => {
  const header = records.find((r) => r.type === "header") ?? {};
  const runStart = records.find((r) => r.type === "run.start") ?? {};
  const llmResponses = records.filter((r) => r.type === "llm.response");

  const steps = [];
  for (const record of records) {
    if (record.type !== "agent.event" || !record.event) continue;
    const event = record.event;
    if (event.type === "tool_call") {
      steps.push({
        step_type: "assistant",
        step_id: event.tool_call_id ?? `tool_call_${steps.length + 1}`,
        timestamp: record.ts,
        tool_calls: [
          {
            id: event.tool_call_id,
            type: "function",
            function_name: event.tool,
            arguments: event.args ?? {},
          },
        ],
      });
      continue;
    }
    if (event.type === "tool_result") {
      steps.push({
        step_type: "assistant",
        step_id: `observation_${steps.length + 1}`,
        timestamp: record.ts,
        observation: {
          results: [
            {
              source_call_id: event.tool_call_id,
              is_error: event.is_error ?? false,
              content: event.result ?? "",
            },
          ],
        },
      });
      continue;
    }
    if (event.type === "final") {
      steps.push({
        step_type: "assistant",
        step_id: `assistant_${steps.length + 1}`,
        timestamp: record.ts,
        message: event.content ?? "",
      });
    }
  }

  const usage = llmResponses
    .map((r) => r.output?.usage)
    .filter(Boolean)
    .reduce(
      (acc, current) => {
        acc.input_tokens += Number(current.input_tokens ?? 0);
        acc.output_tokens += Number(current.output_tokens ?? 0);
        acc.total_tokens += Number(current.total_tokens ?? 0);
        return acc;
      },
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    );

  return {
    schema_version: "1.6",
    session_id: header.session_id ?? runStart.session_id ?? runId,
    agent: {
      name: "codelia",
      version: "unknown",
      model_name: header.model?.name ?? "unknown",
    },
    steps,
    final_metrics: usage,
    extra: {
      run_id: runId,
      source: "codelia-session-jsonl",
      conversion: "best-effort",
    },
  };
};

const run = async () => {
  const options = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();
  const runStamp = nowIso().replaceAll(":", "-").replaceAll(".", "-").replaceAll("Z", "Z-run");
  const runDir = path.join(options.artifactsRoot, runStamp);
  const rawDir = path.join(runDir, "raw");
  const atifDir = path.join(runDir, "atif");
  await mkdir(rawDir, { recursive: true });
  await mkdir(atifDir, { recursive: true });

  console.error(`[terminal-bench] starting run`);
  console.error(`[terminal-bench] artifacts: ${runDir}`);
  console.error(
    `[terminal-bench] model: ${options.modelProvider ?? "(default provider)"}/${options.modelName ?? "(default model)"}`,
  );

  const runtimeArgs = splitArgs(options.runtimeArgs);
  if (runtimeArgs.length === 0) {
    runtimeArgs.push("packages/runtime/src/index.ts");
  }
  runtimeArgs.push("--approval-mode", options.approvalMode);

  const modelOverrideConfigPath = await writeModelOverrideConfig(
    runDir,
    options.modelProvider,
    options.modelName,
  );

  const runtimeEnv = {
    ...process.env,
  };
  if (modelOverrideConfigPath) {
    runtimeEnv.CODELIA_CONFIG_PATH = modelOverrideConfigPath;
    console.error(`[terminal-bench] config override: ${modelOverrideConfigPath}`);
  }

  console.error(`[terminal-bench] runtime: ${options.runtimeCmd} ${runtimeArgs.join(" ")}`);

  const child = spawn(options.runtimeCmd, runtimeArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: runtimeEnv,
  });

  let stdoutRaw = "";
  let stderrRaw = "";
  let parseBuffer = "";
  let runId = null;
  let finalText = "";
  let terminalStatus = null;
  let terminalMessage = null;
  let lastRunStatus = null;
  let processError = null;

  const pending = new Map();
  const failAll = (error) => {
    if (processError) return;
    processError = error;
    for (const handler of pending.values()) {
      handler.reject(error);
    }
    pending.clear();
  };

  const waitResponse = (id) =>
    new Promise((resolve, reject) => {
      if (processError) {
        reject(processError);
        return;
      }
      pending.set(id, { resolve, reject });
    });

  const sendRequest = (message) => {
    if (processError) throw processError;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.on("error", (error) => {
    failAll(error instanceof Error ? error : new Error(String(error)));
  });
  child.on("close", (code, signal) => {
    if (terminalStatus) return;
    failAll(new Error(`runtime exited early (code=${String(code)} signal=${String(signal)})`));
  });
  child.stdin.on("error", (error) => {
    failAll(error instanceof Error ? error : new Error(String(error)));
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutRaw += chunk;
    parseBuffer += chunk;
    let idx = parseBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = parseBuffer.slice(0, idx).trim();
      parseBuffer = parseBuffer.slice(idx + 1);
      if (line.length > 0) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object" && "id" in parsed && !parsed.method) {
              const key = String(parsed.id);
              const waiter = pending.get(key);
              if (waiter) {
                pending.delete(key);
                waiter.resolve(parsed);
              }
            }
            if (parsed?.method === "run.status") {
              const p = parsed.params ?? {};
              if (runId && p.run_id === runId) {
                const status = typeof p.status === "string" ? p.status : null;
                if (status && status !== lastRunStatus) {
                  lastRunStatus = status;
                  console.error(`[terminal-bench] run.status: ${status}`);
                }
                if (status === "completed" || status === "error" || status === "cancelled") {
                  terminalStatus = status;
                  terminalMessage = typeof p.message === "string" ? p.message : null;
                }
              }
            }
            if (parsed?.method === "run.end") {

            const p = parsed.params ?? {};
            if (runId && p.run_id === runId && typeof p.final === "string") {
              finalText = p.final;
            }
          }
          if (parsed?.method === "agent.event") {
            const p = parsed.params ?? {};
            if (runId && p.run_id === runId) {
              const event = p.event ?? {};
              if (event.type === "final" && typeof event.content === "string") {
                finalText = event.content;
              }
            }
          }
        } catch {
          // ignore parser failures
        }
      }
      idx = parseBuffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrRaw += chunk;
  });

  try {
    sendRequest({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocol_version: "0",
        client: { name: "codelia-terminal-bench", version: "0.1.0" },
        ui_capabilities: {
          supports_confirm: false,
          supports_prompt: false,
          supports_pick: false,
        },
      },
    });
      const initRes = await waitResponse("init-1");
      if (initRes.error) {
        throw new Error(`initialize failed: ${initRes.error.message}`);
      }
      console.error("[terminal-bench] initialize: ok");

      sendRequest({

      jsonrpc: "2.0",
      id: "run-1",
      method: "run.start",
      params: {
        input: { type: "text", text: options.prompt },
      },
    });
    const runRes = await waitResponse("run-1");
    if (runRes.error) {
      throw new Error(`run.start failed: ${runRes.error.message}`);
    }
    runId = typeof runRes.result?.run_id === "string" ? runRes.result.run_id : null;
    if (!runId) {
      throw new Error("run.start did not return run_id");
    }

    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (terminalStatus) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (processError) {
          clearInterval(timer);
          reject(processError);
        }
      }, 50);
    });
  } catch (error) {
    await writeFile(path.join(rawDir, "runtime-stdout.ndjson"), stdoutRaw, "utf8");
    await writeFile(path.join(rawDir, "runtime-stderr.log"), stderrRaw, "utf8");
    throw error;
  } finally {
    if (!child.killed) {
      child.kill();
    }
  }

  await writeFile(path.join(rawDir, "runtime-stdout.ndjson"), stdoutRaw, "utf8");
  await writeFile(path.join(rawDir, "runtime-stderr.log"), stderrRaw, "utf8");

  const sessionsDir = resolveStorageSessionsDir();
  const runLogPath = runId ? await findRunLogFile(sessionsDir, runId) : null;
  let atifPath = null;
  if (runLogPath && runId) {
    const copiedSessionLog = path.join(rawDir, `${runId}.jsonl`);
    await copyFile(runLogPath, copiedSessionLog);
    const records = await parseSessionJsonl(runLogPath);
    const atif = toAtif(records, runId);
    atifPath = path.join(atifDir, "trajectory.json");
    await writeFile(atifPath, `${JSON.stringify(atif, null, 2)}\n`, "utf8");
  }

  const summary = {
    run_id: runId,
    status: terminalStatus ?? "error",
    message: terminalMessage,
    final: finalText,
    duration_ms: Date.now() - startedAtMs,
  };
  await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  const metadata = {
    timestamp_utc: nowIso(),
    dataset_id: options.datasetId,
    task_id: options.taskId,
    model_provider: options.modelProvider,
    model_name: options.modelName,
    model_override_config_path: modelOverrideConfigPath,
    approval_mode: options.approvalMode,
    sandbox_backend: "docker-local",
    run_id: runId,
    run_log_path: runLogPath,
    atif_path: atifPath,
    runtime_cmd: options.runtimeCmd,
    runtime_args: runtimeArgs,
    runtime_config_path: runtimeEnv.CODELIA_CONFIG_PATH,
    exit_status: terminalStatus ?? "error",
    prompt_chars: options.prompt.length,
  };
  await writeFile(path.join(runDir, "run-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  if (summary.status === "completed") {
    if (finalText.trim()) {
      console.log(finalText);
    }
    console.error(`[terminal-bench] artifacts: ${runDir}`);
    return 0;
  }

  if (terminalMessage) {
    console.error(terminalMessage);
  }
  console.error(`[terminal-bench] artifacts: ${runDir}`);
  return summary.status === "cancelled" ? 130 : 1;
};

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[terminal-bench] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
