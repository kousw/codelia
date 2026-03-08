# Task orchestration (`packages/runtime/src/tasks`)

- `TaskManager` owns runtime-local orchestration, serialized registry mutations, and lifecycle cleanup/recovery.
- `TaskManager.list()` / `status()` also reconcile stale nonterminal records on observation: dead foreign owners are cancelled, and same-runtime `running` tasks with no live local handle/executor are failed instead of remaining stuck forever.
- Persisted task records come from `@codelia/storage`; keep runtime-only execution handles/process helpers in this directory.
- `shell-executor.ts` is the first concrete task executor: it should preserve `shell.exec` result shape needs while persisting bounded result metadata/cache refs in the task record.
- When retained output is truncated, cache persistence must not depend on `trim()`; whitespace-only stdout/stderr still need cache ids so later reads can recover the full content.
- `TaskManager.spawn` now accepts optional `key` / `label` / `title` / `working_directory` metadata; agent-facing shell tasks persist a stable public `key` for follow-up tool calls, while `label` remains display-only.
- Active shell executors expose live `stdout` / `stderr` snapshots via `TaskExecutionHandle.readOutput`, and `TaskManager.readOutput(...)` is the runtime-facing passthrough used by `shell.output` while a task is still running.
- Do not let late executor completion overwrite an already-terminal task record (shutdown/recovery cancellation must remain authoritative).
- Prefer injectable clocks, process probes, and sleep helpers so Bun tests stay deterministic.
