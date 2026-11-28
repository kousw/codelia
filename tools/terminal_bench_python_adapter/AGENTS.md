# tools/terminal_bench_python_adapter

Harbor adapter (`codelia_agent.py`) for Terminal-Bench. Keep benchmark-specific rituals out of `packages/core/prompts/system.md`.

- **Harbor & ATIF contract**: Keep `SUPPORTS_ATIF = True` (`CODELIA_ATIF_OUT=/logs/agent/trajectory.json`, recording `extra.sandbox_mode_requested` and `extra.sandbox_mode`). Harbor `--debug` sets `CODELIA_PROMPT_PROGRESS_STDERR=1`, `CODELIA_DEBUG=1`, and writes UTC-timestamped logs to `/logs/agent/codelia-output.log`.
- **Sandbox & packaging**: Managed Harbor trials pass `--sandbox-mode full-access` with `--harbor-shell-approval` and `CODELIA_HARBOR_SHELL_APPROVAL=1` (legacy `approval_mode` kwargs map `minimal` -> `readonly` and `trusted`/`full-access` -> `workspace-write`, while explicit `sandbox_mode` always wins; unknown environments refuse `full-access`). `auth_file` uploads `auth.json` only when passed; `codelia_npm_package_files` uploads local npm tarballs before `npm install -g`.
- **Prompt & prefix policy**: `system_terminal_bench.md` is uploaded via `CODELIA_SYSTEM_PROMPT_PATH` (`system_prompt_file` overrides). Keep `BENCHMARK_PREFIX` short, verification-first, free of forced planning/scratch-file rituals, and explicit on anti-hack boundaries (treat external task repos, `solution.sh`, `task.yaml`, trajectories, and hosted fixtures as off-limits). Avoid brittle wording-only prompt tests.
