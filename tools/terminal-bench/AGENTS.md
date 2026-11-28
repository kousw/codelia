# tools/terminal-bench

Benchmark helpers for Terminal-Bench (`dev-docs/specs/terminal-bench.md`). Official scoring is Harbor-driven (`harbor run ...`), not `tools/terminal-bench/scripts/run-benchmark.mjs`; keep helper changes additive without altering product CLI semantics.

- `tools/terminal-bench/scripts/run-benchmark.mjs`: local headless runs (`workspace-write` default; legacy `--approval-mode`: `minimal` -> `readonly`, `trusted`/`full-access` -> `workspace-write`; explicit `--sandbox-mode` always wins); `run-metadata.json` keeps `sandbox_mode_requested` separate from reported `sandbox_mode` (`sandbox_backend`: `"none"` on `full-access`, `null` if unreported).
- `tools/terminal-bench/scripts/rerun-subset.mjs`: dry-run by default (`--execute` runs `harbor run`); preserves original kwargs unless `--sandbox-mode` overrides.
- `tools/terminal-bench/scripts/quick-subset.mjs`: filters completed jobs (`result.json.finished_at` present) matching the base dataset/version/registry signature.
- `tools/terminal-bench/scripts/package-submission.mjs`: packages completed Harbor jobs.
- Keep Compose/example env API key forwarding aligned with `tools/terminal_bench_python_adapter/codelia_agent.py` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `MOONSHOT_API_KEY`, `ZAI_API_KEY`).
