# Terminal-Bench Helpers (Codelia)

This directory contains benchmark-only helpers for Terminal-Bench style unattended runs.

Important boundaries:

- `codelia -p/--prompt` is a **standard product feature**.
- Scripts in `tools/terminal-bench/` are **benchmark orchestration glue**.
- `tools/terminal-bench/docker/` is for **Codelia-only smoke/artifact runs** (no official score).
- **Official Terminal-Bench scoring is done by Harbor** (`harbor run ...`) using Harbor's own docker environment flow.

## What this provides

- Non-interactive benchmark runner script.
- Artifact layout generation under `tmp/terminal-bench/<timestamp>/`.
- Best-effort ATIF conversion from Codelia session JSONL logs.
- Optional Docker-based execution path.

## Prerequisites

- Docker daemon running.
- Provider API key configured (`OPENAI_API_KEY`, etc.).
- Dependencies installed (`bun install`).

## Local run (host)

```bash
tools/terminal-bench/scripts/run-local.sh \
  --prompt "Solve the assigned task in repository" \
  --approval-mode full-access \
  --dataset terminal-bench@2.0 \
  --task-id sample-task-1
```

## Docker run (Codelia-only smoke/artifact run; not official scoring)

This path runs Codelia directly and writes local artifacts. It is useful for
startup checks and trajectory debugging, but Harbor score/leaderboard metrics are
not produced by this command.

```bash
tools/terminal-bench/scripts/run-docker.sh \
  --prompt "Solve the assigned task in repository" \
  --approval-mode full-access \
  --dataset terminal-bench@2.0 \
  --task-id sample-task-1
```

### Docker run with OpenAI OAuth auth.json (Codelia-only run)

If your target model requires OpenAI OAuth credentials, pass only the auth file
into the container (instead of mounting the whole `~/.codelia` directory):

```bash
docker compose -f tools/terminal-bench/docker-compose.yml run --rm \
  -v "$HOME/.codelia/auth.json:/root/.codelia/auth.json:rw" \
  terminal-bench \
  --prompt "Solve the assigned task in repository" \
  --approval-mode full-access \
  --dataset terminal-bench@2.0 \
  --task-id sample-task-1 \
  --model-provider openai \
  --model-name gpt-5.3-codex
```

Notes:

- `:rw` is recommended so token refresh can be persisted.
- `:ro` may fail when refresh is required.

## Scoring (Harbor, official)

`run-local.sh` / `run-docker.sh` produce Codelia run artifacts, but they do not
compute official Terminal-Bench scores.

For submission/leaderboard-style scoring, use Harbor (`harbor run ...`) with the
custom Codelia agent import:

```bash
harbor run --debug \
  -o tmp/terminal-bench/jobs \
  -d terminal-bench@2.0 \
  -n 4 \
  -k 5 \
  --agent-import-path tools.terminal_bench_python_adapter.codelia_agent:CodeliaInstalledAgent \
  --model openai/gpt-5.3-codex \
  --ak approval_mode=full-access \
  --ak auth_file=$HOME/.codelia/auth.json
```

Pin Codelia npm version explicitly (optional):

```bash
harbor run --debug \
  -o tmp/terminal-bench/jobs \
  -d terminal-bench@2.0 \
  -n 4 \
  -k 5 \
  --agent-import-path tools.terminal_bench_python_adapter.codelia_agent:CodeliaInstalledAgent \
  --model openai/gpt-5.3-codex \
  --ak approval_mode=full-access \
  --ak auth_file=$HOME/.codelia/auth.json \
  --ak codelia_npm_version=0.1.22
```

Notes:

- Harbor is the source of truth for benchmark score/leaderboard outputs.
- The custom Harbor adapter is in `tools/terminal_bench_python_adapter/`.
- By default, the adapter installs `@codelia/cli@latest`.
- Set `--ak codelia_npm_version=<version>` for reproducible/pinned runs.
- Use `-k 5` for submission-oriented runs (minimum attempts requirement).
- Use `-o tmp/terminal-bench/jobs` (or another fixed path) to keep job outputs organized for packaging/submission.
- Any additional Harbor flags can be passed after `--` unchanged.

## Submission packaging helper

To make Harbor jobs easier to submit, package completed jobs into a
submission-friendly directory layout:

```bash
node tools/terminal-bench/scripts/package-submission.mjs \
  --job jobs/2026-02-24__01-50-35 \
  --agent-url https://github.com/kousw/codelia \
  --agent-name Codelia \
  --model-name openai/gpt-5.3-codex
```

Output root:

- `tmp/terminal-bench/submissions/submissions/terminal-bench/2.0/<agent>__<model>/`
- includes copied job directories + `metadata.yaml` + `packaging-summary.json`

Optional: combine multiple jobs (for retries/chunks):

```bash
node tools/terminal-bench/scripts/package-submission.mjs \
  --job jobs/2026-02-24__01-50-35 \
  --job jobs/2026-02-24__02-10-12 \
  --agent-url https://github.com/kousw/codelia \
  --agent-name Codelia \
  --model-name openai/gpt-5.3-codex
```

The helper emits warnings for common submission footguns (e.g. unfinished job,
`n_attempts < 5`, resource overrides), but still packages outputs for inspection.

## Submission checklist (Terminal-Bench 2.0)

Before final submission packaging, confirm at least:

- Run is finished (`<job_dir>/result.json` has non-null `finished_at`).
- Attempts are set for submission (`-k 5` on `harbor run`).
- No resource override flags are used for the scored run.
- Job outputs are stored in a stable location (e.g. `-o tmp/terminal-bench/jobs`).
- `metadata.yaml` is present in the packaged submission directory and includes
  valid `agent_url` and model info.

## Output contract

Each run writes:

- `raw/runtime-stdout.ndjson`
- `raw/runtime-stderr.log`
- `raw/<run_id>.jsonl` (copied session log when available)
- `atif/trajectory.json` (best-effort conversion)
- `summary.json`
- `run-metadata.json`

## Model selection

The benchmark runner can force runtime model selection with:

- `--model-provider <openai|anthropic|openrouter>`
- `--model-name <model-id>`

When both are provided, the runner writes a temporary benchmark config file and
sets `CODELIA_CONFIG_PATH` for that run, so host/docker path differences do not
depend on existing `~/.codelia/config.json` state.

## Notes

- `--approval-mode full-access` is recommended for unattended benchmark runs.
- Explicit deny rules in project permissions still apply.
- ATIF output currently uses best-effort mapping from session records.
