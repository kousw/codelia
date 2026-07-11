# Runtime tool follow-ups from Terminal-Bench audit (2026-07-11)

Status: analysis only; none of the changes below are implemented.

This note records the tool-level follow-ups identified while auditing the
completed `gpt-5.6-sol` Terminal-Bench job
`tmp/terminal-bench/jobs/2026-07-11__08-44-39`. It intentionally excludes
task-specific model mistakes and broader prompt changes.

## 1. Make `edit.expected_hash` usable without guessing

Observed issue:

- `edit.expected_hash` accepts an optional SHA-256 guard, but `read` does not
  return the current file hash.
- In `pytorch-model-recovery` and `qemu-alpine-ssh`, the model supplied an
  incorrect hash and received `Hash mismatch` before retrying.
- These transient failures did not determine either benchmark result, but the
  adjacent tool schemas currently invite an unsupported value.

Required response:

- Prefer adding a structured `content_sha256` field to a successful `read`
  result so a value can be copied directly into `edit.expected_hash`.
- Update the `expected_hash` field description to say that it must come from a
  current `read` result or an explicitly computed hash and should otherwise be
  omitted.
- Add tests covering a read-to-guarded-edit success, stale-hash rejection, and
  an unguarded edit.

## 2. Support stdin for managed interactive shell tasks

Observed issue:

- The managed shell tools support start, list, status, logs, wait, result, and
  cancellation, but cannot write to a running process's stdin.
- The `qemu-alpine-ssh` trial therefore constructed socket and Python helpers
  to interact with the serial console. This contributed to a 56-call workflow
  that reached the 900-second agent timeout.
- This is a tool-surface limitation rather than evidence that the existing
  shell execution tools malfunctioned.

Required response:

- Add a narrowly scoped managed-task stdin operation, tentatively
  `shell_write`, keyed by the existing public shell task `key`.
- Define byte/text behavior, newline handling, closed-stdin behavior, task
  state validation, output/backpressure limits, and permission behavior before
  implementation.
- Do not turn `shell_write` into a general terminal emulator. PTY allocation,
  resize, and terminal control should be evaluated separately if plain stdin
  proves insufficient for QEMU, REPL, or installer workflows.
- Add integration tests for write/read interaction, repeated writes, stdin
  closure, writes after task completion, cancellation, and bounded waits.

## 3. Use a monotonic clock for elapsed durations

Observed issue:

- Two trials logged negative elapsed durations:
  `chess-best-move` (`-2746ms`) and `path-tracing` (`-2488ms`).
- Both commands completed successfully, so this is an observability defect and
  did not cause their benchmark outcome.

Required response:

- Calculate elapsed durations from a monotonic clock such as
  `performance.now()` or `process.hrtime.bigint()`.
- Continue using wall-clock timestamps for human-readable event time, but do
  not derive elapsed duration by subtracting wall-clock timestamps.
- Audit both shell task result duration and agent step duration, because the
  negative values appeared in both `shell.done` and `step_complete` records.
- Add deterministic tests that simulate wall-clock movement while asserting
  non-negative monotonic durations.

## Validation boundary

After implementation, run the smallest runtime tool tests first, followed by:

```sh
bun test packages/runtime/tests
bun run typecheck
bun run fmt
```

Rerunning the full 89-task benchmark is not required to validate items 1 and 3.
Item 2 should additionally receive a focused QEMU or interactive-process smoke
test before using Terminal-Bench score changes as evidence.
