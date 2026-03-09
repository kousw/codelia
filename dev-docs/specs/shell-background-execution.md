# Shell Background Execution Spec (B-035)

Status: `Planned` (2026-02-28)

This spec defines the shell-specific UX/RPC profile over the common task orchestration substrate while preserving the current "feels synchronous" UX by default.

Canonical naming/lifecycle rules now live in `dev-docs/specs/task-orchestration.md`. Historical `job` wording in older drafts should be read as `task`.

---

## 0. Motivation

Current bang shell (`!cmd`) blocks until `shell.exec` returns.
For long-running commands, users need to keep working without losing command output.

Desired UX:

1. Shell execution should be internally task-based (asynchronous).
2. Default behavior can still feel synchronous (wait for completion).
3. User can switch active wait to background while running (for example `Ctrl+B`).
4. Output must remain retrievable (tail/read/cached full output).

---

## 1. Scope / Non-goals

### In scope

- Task model for shell execution.
- Runtime APIs for shell task lifecycle (`start/list/status/cancel/output`).
- TUI UX for:
  - wait mode (current behavior equivalent)
  - immediate background mode
  - in-flight detach (`Ctrl+B`) while waiting.
- Compatibility plan with existing `shell.exec` and deferred `<shell_result>` injection.

### Non-goals (initial)

- Full interactive PTY attach session.
- Arbitrary job dependency graph or scheduling policy.
- Cross-device distributed job execution.

---

## 2. UX Contract

### 2.1 Execution modes

Bang command supports two user-level modes:

- **Wait mode (default):** starts a shell task and waits until terminal status.
  - User experience is similar to current synchronous `shell.exec`.
- **Background mode:** starts a shell task and returns immediately.
  - TUI logs `Started background shell task <task_id>`.
  - This detaches the wait only; the runtime still owns the child process, so it is not a persistence/daemonization mechanism.

### 2.2 In-flight detach (`Ctrl+B`)

When TUI is waiting on a shell task:

- `Ctrl+B` detaches UI wait from that task.
- Task continues in runtime.
- TUI returns to normal composer input.
- TUI logs `Detached shell task <task_id> (running in background)`.

### 2.3 Post-detach task operations

TUI should expose a minimal command surface:

- `/tasks` (summary list)
- `/tasks show <task_id>` (status + preview)
- `/tasks tail <task_id>` (incremental output)
- `/tasks cancel <task_id>`

(Exact slash-command names can be adjusted; lifecycle capability is required.)

---

## 3. Execution Model

Runtime treats every shell run as a task with stable identity.
Persistent services that must survive runtime exit are out of scope for this task model and should use explicit shell-native out-of-process techniques instead.

Task states:

- `queued` (optional)
- `running`
- `completed`
- `failed`
- `cancelled`

Task record (minimum):

- `task_id`
- `command`
- `cwd`
- `started_at`
- `ended_at?`
- `exit_code?`
- `signal?`
- `stdout_cache_id?`
- `stderr_cache_id?`
- truncation metadata

Output policy:

- small output inline in status/result
- large output persisted in tool-output cache, retrieved by reference

---

## 4. Protocol Surface (proposal)

Add `shell.*` RPC methods (UI -> Runtime):

1. `shell.start`
   - starts a shell task, returns `task_id` immediately
   - accepts timeout values above 300 seconds; if `timeout_seconds` is omitted, the shell task runs until completion, cancellation, or runtime exit
2. `shell.list`
   - returns recent shell tasks and state summary
3. `shell.status`
   - returns single-task detail
4. `shell.output`
   - paged/tail output retrieval
5. `shell.cancel`
   - cancel running shell task
6. `shell.wait`
   - wait for terminal status with timeout semantics
   - `wait_timeout_seconds` default 120, max 300
   - if the wait window expires first, return current task info with `still_running: true`
7. `shell.detach`
   - detach active wait without cancelling the underlying shell task

### 4.1 Capability flags

Extend server capabilities:

- `supports_shell_tasks?: boolean`
- `supports_shell_detach?: boolean`

---

## 5. Compatibility with existing `shell.exec`

Current `shell.exec` is implemented and used by bang flow.

Compatibility policy:

- Keep `shell.exec` in phase 1 for older clients.
- Runtime may implement `shell.exec` as wrapper behavior over the shell task substrate.
- New TUI path should prefer shell task APIs (`shell.start` + optional `shell.wait`).
- The existing `shell.exec` confirm bypass remains limited to the UI-origin bang path (`origin=ui_bang`) and must not leak into agent-originated shell tasks built on the same substrate.

---

## 6. Deferred `<shell_result>` Integration

Deferred injection rules stay compatible:

- If user waits and command completes before next prompt, enqueue normal `<shell_result>`.
- If detached/background shell task completes later, user can:
  - explicitly inject selected task result, or
  - use a helper command that appends the latest completed task summary.

Initial recommendation: explicit injection to avoid accidental context pollution.

---

## 7. TUI State Changes (planned)

Add state buckets:

- `active_shell_wait: Option<task_id>`
- `shell_tasks: Vec<ShellTaskSummary>` (recent cache)
- `shell_tail_cursor_by_task: HashMap<task_id, cursor>` (for incremental output)

Key handling:

- `Ctrl+B` is active only when `active_shell_wait` exists and issues `shell.detach { task_id }`.
- Outside shell wait, keep existing key behavior unchanged.

---

## 8. Runtime Behavior Notes

- Shell task execution reuses existing shell runner and sandbox constraints.
- Cancellation maps to process group termination where supported.
- Persist `executor_pid` / `executor_pgid` so crash recovery can terminate orphaned shell tasks.
- Task metadata retention should be bounded (LRU/time window) to avoid unbounded memory growth.
- Long output should always be recoverable via cache IDs while respecting size limits.

---

## 9. Test Plan

### 9.1 Runtime tests

- `shell.start` returns `task_id`, state transitions to `running`.
- completion path stores status/output metadata plus persisted executor identifiers needed for recovery.
- `shell.cancel` transitions running shell task to `cancelled`.
- `shell.output` paged/tail retrieval works with cache-backed output.
- `shell.detach` detaches wait without cancelling the underlying shell task.

### 9.2 TUI tests

- wait mode behaves equivalent to legacy synchronous UX.
- `Ctrl+B` while waiting detaches and restores composer usability.
- detached shell task remains visible in `/tasks` and can be tailed/cancelled.

### 9.3 Compatibility tests

- legacy `shell.exec` callers still function.
- mixed old/new capability negotiation degrades safely.

---

## 10. Rollout Plan

1. Common task substrate + shell-specific `shell.*` compatibility API behind capability flag.
2. TUI task UI (`/tasks`, wait mode backed by shell tasks).
3. `Ctrl+B` in-flight detach via `shell.detach`.
4. Optional deprecation path for direct blocking `shell.exec` behavior.

---

## 11. Related docs

- `dev-docs/specs/task-orchestration.md` (canonical substrate/lifecycle/naming)
- `dev-docs/specs/backlog.md` (B-035)
- `dev-docs/specs/tui-bang-shell-mode.md`
- `dev-docs/specs/ui-protocol.md`
