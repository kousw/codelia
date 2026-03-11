# terminal_bench_python_adapter

## Scope

- `codelia_agent.py` owns the Harbor adapter that installs and runs Codelia for Terminal Bench.
- Keep benchmark-specific behavior here; do not push Terminal Bench rituals into the shared system prompt unless the policy truly applies everywhere.

## Prefix policy

- Keep `BENCHMARK_PREFIX` short and benchmark-specific.
- Prefer verification-first instructions over planning rituals.
- Do not require visible planning or verification artifacts such as `/tmp/*task-state*` files unless a future benchmark requirement explicitly depends on them.
- Avoid instructions that force end-of-task rereads of planning artifacts.
