# tools/terminal-bench

Benchmark helper scripts for Terminal-Bench workflows.

- `scripts/run-benchmark.mjs`: single headless Codelia run for local/debug artifacts.
  Launcher mode defaults to `workspace-write` for both `run-local.sh` and Compose. Pass `--sandbox-mode` to select a different mode. Legacy `minimal` maps to `readonly` and legacy `trusted` or `full-access` maps to `workspace-write`.
  `run-metadata.json` records `sandbox_mode_requested` separately from the `sandbox_mode` reported by runtime initialization. `approval_mode` retains the original legacy option when present. `sandbox_backend` is `none` for a reported `full-access` mode and null when the runtime does not report a backend.
- `scripts/rerun-subset.mjs`: build filtered Harbor rerun config from an existing job.
  - reads `<jobDir>/result.json` + `<jobDir>/config.json`
  - supports `--scope failed|timeout|error`
  - dry-run by default, executes `harbor run -c <generated-config>` with `--execute`
- `scripts/package-submission.mjs`: package completed Harbor jobs for submission layout.

Notes:

- Official scoring is Harbor-driven (`harbor run ...`), not `run-benchmark.mjs`.
- Keep benchmark helper behavior additive and avoid changing product CLI semantics.
- Harbor adapter (`tools/terminal_bench_python_adapter/codelia_agent.py`) checks Harbor job `debug=true` (e.g. `harbor run --debug`).
- Harbor adapter declares `SUPPORTS_ATIF = True` and writes `/logs/agent/trajectory.json` through `CODELIA_ATIF_OUT`; keep this path stable for Harbor compatibility.
- Harbor provider credential forwarding includes `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, and `ZAI_API_KEY`; keep Compose and the example env aligned with this list.
- Harbor adapter uploads `auth.json` only when `auth_file` is explicitly passed;
- Harbor adapter can upload local npm package tarballs through `codelia_npm_package_files` for pre-publish Harbor validation.
- Harbor adapter uploads `tools/terminal_bench_python_adapter/system_terminal_bench.md` by default and sets `CODELIA_SYSTEM_PROMPT_PATH` inside the container; `system_prompt_file` overrides that default.
- The Harbor adapter adds benchmark-only prompt guidance for non-interactive execution, concrete early exploration, verifier-facing evidence, and lightweight ambiguity handling for externally observed output contracts.
- In debug jobs it enables `CODELIA_PROMPT_PROGRESS_STDERR=1`, sets `CODELIA_DEBUG=1`, and writes UTC timestamp-prefixed lines to `/logs/agent/codelia-output.log`.
- `scripts/quick-subset.mjs` builds a low-cost prompt-eval Harbor config from historical jobs by filtering/ranking tasks with per-task success rate, mean duration, and timeout counts.
  - It only aggregates completed Harbor jobs (`result.json.finished_at` present).
  - It only aggregates jobs whose dataset config matches the selected base job (same dataset/version/registry signature).
  - `--sandbox-mode` sets the Harbor agent's `sandbox_mode`. An explicit legacy override replaces an inherited mode. A rerun without an override preserves the original agent kwargs.
