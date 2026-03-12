# terminal_bench_python_adapter

## Scope

- `codelia_agent.py` owns the Harbor adapter that installs and runs Codelia for Terminal Bench.
- Keep benchmark-specific behavior here; do not push Terminal Bench rituals into the shared system prompt unless the policy truly applies everywhere.

## Prefix policy

- Keep `BENCHMARK_PREFIX` short and benchmark-specific.
- Prefer verification-first instructions over planning rituals.
- Do not require visible planning or verification artifacts such as `/tmp/*task-state*` files unless a future benchmark requirement explicitly depends on them.
- Avoid instructions that force end-of-task rereads of planning artifacts.
- Keep anti-hack guidance explicit: benchmark-specific answers, public task repos/artifacts, `solution.sh`, `task.yaml`, trajectories, and externally hosted fixtures should be treated as off-limits unless already provided in `/app`.
- Do not add tests whose only purpose is to assert prompt wording/text presence; prefer behavior checks, and skip tests entirely for wording-only prompt tweaks unless there is a stronger contract to verify.
- `system_prompt_file` may be uploaded into the benchmark container and wired through `CODELIA_SYSTEM_PROMPT_PATH`; keep this override explicit and file-backed.
