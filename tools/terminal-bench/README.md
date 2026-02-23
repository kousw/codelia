# Terminal-Bench Helpers (Codelia)

This directory contains benchmark-only helpers for Terminal-Bench style unattended runs.

Important boundary:

- `codelia -p/--prompt` is a **standard product feature**.
- Scripts in `tools/terminal-bench/` are **benchmark orchestration glue**.

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

## Docker run

```bash
tools/terminal-bench/scripts/run-docker.sh \
  --prompt "Solve the assigned task in repository" \
  --approval-mode full-access \
  --dataset terminal-bench@2.0 \
  --task-id sample-task-1
```

### Docker run with OpenAI OAuth auth.json (for `openai/gpt-5.3-codex`)

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

## Scoring (Harbor)

`run-local.sh` / `run-docker.sh` produce Codelia run artifacts, but they do not
compute official Terminal-Bench scores.

Use Harbor for scored runs with the custom Codelia agent import:

```bash
tools/terminal-bench/scripts/run-harbor.sh -- \
  --debug \ 
  -d terminal-bench@2.0 \
  --agent-import-path tools.terminal_bench_python_adapter.codelia_agent:CodeliaInstalledAgent \
  --model openai/gpt-5.3-codex \
  --ak approval_mode=full-access \
  --ak auth_file=$HOME/.codelia/auth.json
```
or
```bash
harbor run --debug \
  -d terminal-bench@2.0 \
  --agent-import-path tools.terminal_bench_python_adapter.codelia_agent:CodeliaInstalledAgent \
  --model openai/gpt-5.3-codex \
  --ak approval_mode=full-access \
  --ak auth_file=$HOME/.codelia/auth.json
```
Notes:

- Harbor is the source of truth for benchmark score/leaderboard outputs.
- The custom Harbor adapter is in `tools/terminal_bench_python_adapter/`.
- The wrapper stores stdout/stderr logs under `tmp/terminal-bench/harbor/`.
- Any additional Harbor flags can be passed after `--` unchanged.

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
