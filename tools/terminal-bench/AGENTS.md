# tools/terminal-bench

Benchmark helper scripts for Terminal-Bench workflows.

- `scripts/run-benchmark.mjs`: single headless Codelia run for local/debug artifacts.
- `scripts/rerun-subset.mjs`: build filtered Harbor rerun config from an existing job.
  - reads `<jobDir>/result.json` + `<jobDir>/config.json`
  - supports `--scope failed|timeout|error`
  - dry-run by default, executes `harbor run -c <generated-config>` with `--execute`
- `scripts/package-submission.mjs`: package completed Harbor jobs for submission layout.

Notes:

- Official scoring is Harbor-driven (`harbor run ...`), not `run-benchmark.mjs`.
- Keep benchmark helper behavior additive and avoid changing product CLI semantics.
- Harbor adapter (`tools/terminal_bench_python_adapter/codelia_agent.py`) checks Harbor job `debug=true` (e.g. `harbor run --debug`).
- Harbor adapter uploads `auth.json` only when `auth_file` is explicitly passed;
- Harbor adapter uploads a custom system prompt file only when `system_prompt_file` is explicitly passed and then sets `CODELIA_SYSTEM_PROMPT_PATH` inside the container.
- The Harbor adapter adds benchmark-only prompt guidance for non-interactive execution, concrete early exploration, verifier-facing evidence, and lightweight ambiguity handling for externally observed output contracts.
- In debug jobs it enables `CODELIA_PROMPT_PROGRESS_STDERR=1`, sets `CODELIA_DEBUG=1`, and writes UTC timestamp-prefixed lines to `/logs/agent/codelia-output.log`.
- `scripts/quick-subset.mjs` builds a low-cost prompt-eval Harbor config from historical jobs by filtering/ranking tasks with per-task success rate, mean duration, and timeout counts.
  - It only aggregates completed Harbor jobs (`result.json.finished_at` present).
  - It only aggregates jobs whose dataset config matches the selected base job (same dataset/version/registry signature).
