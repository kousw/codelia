# Task orchestration (`packages/runtime/src/tasks`)

- `TaskManager` owns runtime-local orchestration, serialized registry mutations, and lifecycle cleanup/recovery.
- Persisted task records come from `@codelia/storage`; keep runtime-only execution handles/process helpers in this directory.
- Do not let late executor completion overwrite an already-terminal task record (shutdown/recovery cancellation must remain authoritative).
- Prefer injectable clocks, process probes, and sleep helpers so Bun tests stay deterministic.
