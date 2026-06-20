# terminal_bench_python_adapter

## Scope

- `codelia_agent.py` owns the Harbor adapter that installs and runs Codelia for Terminal Bench.
- Keep benchmark-specific behavior here; do not push Terminal Bench rituals into the shared system prompt unless the policy truly applies everywhere.
- The adapter must keep `SUPPORTS_ATIF = True` and write Harbor's expected `/logs/agent/trajectory.json` via `CODELIA_ATIF_OUT`.
- Use `codelia_npm_package_files` when validating unpublished workspace changes in Harbor; it uploads local npm tarballs into `/tmp/codelia/` before `npm install -g`.

## Prefix policy

- Keep `BENCHMARK_PREFIX` short and benchmark-specific.
- Prefer verification-first instructions over planning rituals.
- Do not require visible planning or verification artifacts such as `/tmp/*task-state*` files unless a future benchmark requirement explicitly depends on them.
- Avoid instructions that force end-of-task rereads of planning artifacts.
- Keep anti-hack guidance explicit: benchmark-specific answers, public task repos/artifacts, `solution.sh`, `task.yaml`, trajectories, and externally hosted fixtures should be treated as off-limits unless already provided in `/app`.
- Keep generic Terminal Bench execution and verification policy in `system_terminal_bench.md`; keep the adapter-side benchmark prefix minimal and avoid duplicating system-prompt policy there.
- Do not add tests whose only purpose is to assert prompt wording/text presence; prefer behavior checks, and skip tests entirely for wording-only prompt tweaks unless there is a stronger contract to verify.
- `system_terminal_bench.md` is the default uploaded system prompt for Harbor runs; `system_prompt_file` is an explicit file-backed override wired through `CODELIA_SYSTEM_PROMPT_PATH`.
