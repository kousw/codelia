# Runtime tool observations from Terminal-Bench audit (2026-07-11)

Status: implementation follow-up note. The observations below are verified.
Item 1 is implemented, item 3 has a selected design, and item 2 has a bounded
proposal with a prototype gate.

This note records runtime-tool observations from the completed `gpt-5.6-sol`
Terminal-Bench job at `tmp/terminal-bench/jobs/2026-07-11__08-44-39`.
Benchmark-specific model mistakes are included only when they expose a tool
contract or capability question.

## Decision summary

| Topic | Verified observation | Known impact | Decision status |
| --- | --- | --- | --- |
| `edit.expected_hash` discoverability | `edit` accepts a hash guard, but `read` did not expose the corresponding hash | Eight trials incurred one recoverable `Hash mismatch` each; no known result was determined by it | Implemented |
| Managed shell stdin | Managed shell tasks cannot receive stdin after start | The QEMU trial used socket and Python helpers in a 56-call run that reached the 900-second agent timeout | Proposed bounded design; prototype required |
| Elapsed-duration clock | Shell-task and agent-step durations use wall-clock subtraction | Two successful commands reported negative durations; no task result was affected | Narrow fix selected; not implemented |

## 1. `edit.expected_hash` discoverability

Decision status: implemented.

### Current behavior

- Implemented: `edit.expected_hash` is an optional SHA-256 guard. A mismatch
  rejects the edit.
- Implemented: `read` returns a bounded text preview and does not expose the
  full file hash.
- A caller can compute the hash separately or omit the optional guard. The
  limitation is discoverability through the adjacent `read` tool, not lack of
  hash-guard support.

Implementation evidence:

- `packages/runtime/src/tools/edit.ts`
- `packages/runtime/src/tools/read.ts`
- `dev-docs/specs/edit-tool.md`

### Audit evidence and impact

Eight trajectories contained one recoverable `Hash mismatch` each:

- `cancel-async-tasks`
- `install-windows-3.11`
- `large-scale-text-editing`
- `path-tracing-reverse`
- `path-tracing`
- `pytorch-model-cli`
- `pytorch-model-recovery`
- `winning-avg-corewars`

The failures added retries but are not known to have determined any benchmark
result. `qemu-alpine-ssh` did not contain a `Hash mismatch`.

### Implemented design

Implemented: preserve the existing text result and append one stable metadata
footer to every successful `read` and `read_line` result:

```text
    1  const message = "hello";

[read_metadata] content_sha256=<lowercase-64-hex>
```

The contract is:

- `content_sha256` is the SHA-256 guard value accepted unchanged by
  `edit.expected_hash`.
- The hash covers the complete UTF-8 text content used by `edit`, not the
  numbered, clipped, offset, paged, or otherwise formatted preview.
- Offset, limited, truncated, and `read_line` reads of the same unchanged file
  return the same full-content hash.
- The footer is not file content. It follows the existing human-readable
  truncation and follow-up notices rather than wrapping source text in JSON.
- The footer is the final non-empty line. Successful empty-file reads include
  it; directory, missing-file, range, security, and other error results do not.
- `edit.expected_hash` documentation must say to copy `content_sha256` from a
  current `read` or `read_line` result or explicitly compute the same
  full-content hash; omit the optional guard otherwise.
- `read`, `read_line`, and `edit` must use the same shared hash helper so the
  producers and consumer cannot drift.
- Do not normalize line endings before hashing. Preserve the current `edit`
  behavior of hashing the UTF-8 string read from disk and emit lowercase
  64-character hexadecimal output.
- Validate `edit.expected_hash` as lowercase 64-character hexadecimal. Values
  that could match the current lowercase hash already satisfy this restriction.

Performance note: both read tools already load and process the complete file.
Hashing adds no filesystem I/O and no retained cache, but adds one linear-time
SHA-256 pass over the UTF-8 content. This is expected to be negligible for
normal source files; do not cache the value because stale cache reuse would
weaken the guard.

Tests should cover full, offset, truncated, empty-file, and `read_line` reads;
a read-to-guarded-edit success; stale-hash rejection; invalid hash format; and
unchanged unguarded editing behavior.

## 2. Managed shell stdin

Decision status: proposed bounded design; prototype required before
implementation approval.

### Current behavior

- Implemented: agent-facing managed shell tools can start, list, inspect, wait
  for, read output from, and cancel retained shell tasks.
- Implemented: the child process is spawned with stdin set to `ignore`.
- Not implemented: writing to, or explicitly closing, a running task's stdin.

Implementation evidence:

- `packages/runtime/src/tools/shell.ts`
- `packages/runtime/src/tasks/shell-executor.ts`
- `packages/runtime/src/tasks/types.ts`
- `packages/runtime/src/tasks/manager.ts`

### Audit evidence and impact

The `qemu-alpine-ssh` trial used socket and Python helpers to interact with the
QEMU monitor and serial console. The run made 56 tool calls and reached the
900-second agent timeout. A managed stdin capability could simplify this class
of workflow, but the audit does not prove that plain piped stdin would have
made the trial succeed.

### Proposed design

Add an opt-in stdin pipe and one explicitly constrained agent-facing follow-up
tool named `shell_stdin_write`.

Shell start contract:

- Add `stdin_mode: "closed" | "pipe"` to the agent-facing `shell` tool.
- Default to `closed`, preserving the current immediate-EOF behavior.
- Require `detached_wait=true` when `stdin_mode="pipe"`; reject the combination
  at schema validation otherwise. A foreground tool call cannot issue a
  follow-up write while waiting for process completion.
- Phase 1 is agent-facing only. Do not add a Core-to-UI RPC stdin method until a
  UI consumer is identified.

Proposed `shell_stdin_write` input:

```ts
type ShellStdinWriteInput = {
  key: string;
  text: string;
  append_newline?: boolean; // default false
  close?: boolean; // write first, then close stdin; default false
};
```

Behavior and limits:

- Accept UTF-8 text only in phase 1; no raw bytes or base64 input.
- Limit each call to 64 KiB after optional newline encoding.
- Serialize writes per task. Resolve a write only after the writable stream
  callback completes, with a 30-second backpressure timeout.
- Do not impose a cumulative byte limit in phase 1: consumed stdin is not
  retained, and repeated bounded writes are the intended interaction model.
- Permit `text=""` with `close=true` for close-only behavior; reject an empty
  write with `close=false`.
- Return compact JSON containing `key`, current `state`, `bytes_written`, and
  `stdin_closed`. Output inspection remains the responsibility of `shell_logs`
  and completion waiting remains the responsibility of `shell_wait`.
- Reject writes when stdin was not opened as a pipe, was already closed, the
  task is terminal, backpressure times out, or the task is not a live local
  execution handle.
- Restrict writes to a task owned by the current runtime and, when
  `parent_session_id` is present, the current agent session. The task key alone
  is not authority to write to another session's process.
- Treat the operation as a continuation of the already-authorized shell task.
  It may be allowlisted like other bounded shell follow-up tools only after the
  ownership checks above are enforced.
- Closing, cancellation, timeout, process exit, and runtime shutdown must close
  or invalidate the writable handle exactly once.
- Keep PTY allocation, resize, terminal control, and persistence across runtime
  exit out of scope.

Implementation surfaces if approved:

- `packages/runtime/src/tasks/types.ts`: add bounded write/close operations to
  the live `TaskExecutionHandle` contract.
- `packages/runtime/src/tasks/manager.ts`: route writes only to eligible local
  active handles.
- `packages/runtime/src/tasks/shell-executor.ts`: opt into piped stdin and
  implement serialized bounded writes and close semantics.
- `packages/runtime/src/tools/shell.ts`: add `stdin_mode` and register
  `shell_stdin_write` with same-session task resolution.
- `packages/runtime/src/permissions/service.ts`, runtime tool registration,
  prompts, tests, and local `AGENTS.md`: describe the new constrained follow-up
  operation.

Prototype gate: first validate the contract against a small line-oriented
Node/Python process, then QEMU monitor and serial-console smoke cases. Proceed
only if plain pipes materially simplify at least one target workflow. PTY needs
become a separate design item rather than expanding this tool.

## 3. Elapsed-duration clock

Decision status: narrow fix selected; not implemented.

### Current behavior

- Implemented: shell-task `duration_ms` uses `Date.now()` subtraction.
- Implemented: agent `step_complete.duration_ms` also uses `Date.now()`
  subtraction.
- Wall-clock adjustment can therefore produce a negative or exaggerated
  elapsed duration.

Implementation evidence:

- `packages/runtime/src/tasks/shell-executor.ts`
- `packages/core/src/agent/agent.ts`

### Audit evidence and impact

- `chess-best-move`: `shell.done=-2746ms`, corresponding
  `step_complete=-2740ms`.
- `path-tracing`: `shell.done=-2488ms`, corresponding
  `step_complete=-2480ms`.
- Both commands completed successfully. This was an observability defect and
  did not affect their task result.

### Selected design and modification scope

Use a monotonic clock only for the two elapsed-duration paths demonstrated by
the audit:

- `packages/runtime/src/tasks/shell-executor.ts`
  - Replace the `Date.now()` start/end subtraction used for task
    `result.duration_ms`.
  - Add an internal `monotonicNowMs?: () => number` option to
    `startShellTask`, defaulting to `performance.now()`.
  - Capture the elapsed value once when settling so output-cache success and
    fallback paths report the same duration.
- `packages/core/src/agent/agent.ts`
  - Replace both success and error `step_complete.duration_ms` wall-clock
    subtractions.
  - Add `monotonicNowMs?: () => number` to `AgentServices`, defaulting to
    `performance.now()`, so tests can move wall time independently.

For both paths:

```ts
const durationMs = Math.max(
  0,
  Math.round(monotonicNowMs() - monotonicStartedAt),
);
```

- Preserve integer millisecond output and the defensive non-negative clamp.
- Continue using wall-clock ISO timestamps for event and task timestamps.
- Do not change timeout scheduling or cancellation behavior.
- Leave hosted web-search's fixed zero duration unchanged.
- Leave `webfetch`, Terminal-Bench runner summaries, idle-age checks, and
  timestamp-derived reporting outside this narrow fix. They can be audited
  separately if duration becomes a stronger product or operational signal.

Performance impact:

- Two monotonic clock reads and one subtraction/round/clamp are performed per
  measured operation, the same asymptotic work as the current wall-clock
  calculation.
- `performance.now()` is an in-process monotonic clock read; no I/O, polling,
  timers, or persistent allocation is added.
- The injected function adds one indirect call at measurement boundaries only.
  Its overhead is negligible relative to process execution or a model tool
  call and should not receive a dedicated benchmark gate.
- Runtime and memory behavior outside duration reporting is unchanged.

Tests must simulate wall-clock movement while monotonic time advances, cover
shell settlement including output-cache fallback, and cover both successful
and failed agent tool steps.

## Validation if a candidate is selected

Run focused tests for only the selected candidate first.

For `expected_hash` / `read` changes:

```sh
bun test packages/runtime/tests/read-tool.test.ts
bun test packages/runtime/tests/read-line-tool.test.ts
bun test packages/runtime/tests/write-edit-tools.test.ts
```

For managed shell stdin changes:

```sh
bun test packages/runtime/tests/shell-tool.test.ts
bun test packages/runtime/tests/shell-exec.test.ts
```

For elapsed-duration changes:

```sh
bun test packages/runtime/tests/shell-executor.test.ts
bun test packages/core/tests/agent.test.ts
```

Then run the normal repository checks:

```sh
bun run typecheck
bun run fmt
```

Rerunning the full 89-task benchmark is not required to validate any isolated
candidate. Benchmark score changes should be treated as later outcome evidence,
not as the primary correctness check.
