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
- In debug jobs it enables `CODELIA_PROMPT_PROGRESS_STDERR=1` and writes UTC timestamp-prefixed lines to `/logs/agent/codelia-output.log`.
