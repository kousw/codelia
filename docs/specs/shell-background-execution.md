# Shell Background Execution Spec (B-035)

Status: `Planned` (2026-02-28)

This spec defines background-capable shell execution for TUI/runtime while preserving the current "feels synchronous" UX by default.

---

## 0. Motivation

Current bang shell (`!cmd`) blocks until `shell.exec` returns.
For long-running commands, users need to keep working without losing command output.

Desired UX:

1. Shell execution should be internally job-based (asynchronous).
2. Default behavior can still feel synchronous (wait for completion).
3. User can switch active wait to background while running (for example `Ctrl+B`).
4. Output must remain retrievable (tail/read/cached full output).

---

## 1. Scope / Non-goals

### In scope

- Job model for shell execution.
- Runtime APIs for job lifecycle (`start/list/status/cancel/output`).
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

- **Wait mode (default):** starts a shell job and waits until terminal status.
  - User experience is similar to current synchronous `shell.exec`.
- **Background mode:** starts a shell job and returns immediately.
  - TUI logs `Started background shell job <job_id>`.

### 2.2 In-flight detach (`Ctrl+B`)

When TUI is waiting on a shell job:

- `Ctrl+B` detaches UI wait from that job.
- Job continues in runtime.
- TUI returns to normal composer input.
- TUI logs `Detached shell job <job_id> (running in background)`.

### 2.3 Post-detach job operations

TUI should expose a minimal command surface:

- `/jobs` (summary list)
- `/jobs show <job_id>` (status + preview)
- `/jobs tail <job_id>` (incremental output)
- `/jobs cancel <job_id>`

(Exact slash-command names can be adjusted; lifecycle capability is required.)

---

## 3. Execution Model

Runtime treats every shell run as a job with stable identity.

Job states:

- `queued` (optional)
- `running`
- `completed`
- `failed`
- `cancelled`

Job record (minimum):

- `job_id`
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
   - starts a job, returns `job_id` immediately
2. `shell.list`
   - returns recent jobs and state summary
3. `shell.status`
   - returns single-job detail
4. `shell.output`
   - paged/tail output retrieval
5. `shell.cancel`
   - cancel running job

Optional convenience method:

6. `shell.wait`
   - wait for terminal status with timeout/cancel semantics

### 4.1 Capability flags

Extend server capabilities:

- `supports_shell_jobs?: boolean`
- `supports_shell_detach?: boolean`

---

## 5. Compatibility with existing `shell.exec`

Current `shell.exec` is implemented and used by bang flow.

Compatibility policy:

- Keep `shell.exec` in phase 1 for older clients.
- Runtime may implement `shell.exec` as wrapper behavior over job engine.
- New TUI path should prefer job APIs (`shell.start` + optional wait behavior).

---

## 6. Deferred `<shell_result>` Integration

Deferred injection rules stay compatible:

- If user waits and command completes before next prompt, enqueue normal `<shell_result>`.
- If detached/background job completes later, user can:
  - explicitly inject selected job result, or
  - use a helper command that appends latest completed job summary.

Initial recommendation: explicit injection to avoid accidental context pollution.

---

## 7. TUI State Changes (planned)

Add state buckets:

- `active_shell_wait: Option<job_id>`
- `shell_jobs: Vec<ShellJobSummary>` (recent cache)
- `shell_tail_cursor_by_job: HashMap<job_id, cursor>` (for incremental output)

Key handling:

- `Ctrl+B` is active only when `active_shell_wait` exists.
- Outside shell wait, keep existing key behavior unchanged.

---

## 8. Runtime Behavior Notes

- Job execution reuses existing shell runner and sandbox constraints.
- Cancellation maps to process group termination where supported.
- Job metadata retention should be bounded (LRU/time window) to avoid unbounded memory growth.
- Long output should always be recoverable via cache IDs while respecting size limits.

---

## 9. Test Plan

### 9.1 Runtime tests

- `shell.start` returns `job_id`, state transitions to `running`.
- completion path stores status/output metadata.
- `shell.cancel` transitions running job to `cancelled`.
- `shell.output` paged/tail retrieval works with cache-backed output.

### 9.2 TUI tests

- wait mode behaves equivalent to legacy synchronous UX.
- `Ctrl+B` while waiting detaches and restores composer usability.
- detached job remains visible in `/jobs` and can be tailed/cancelled.

### 9.3 Compatibility tests

- legacy `shell.exec` callers still function.
- mixed old/new capability negotiation degrades safely.

---

## 10. Rollout Plan

1. Runtime job engine + `shell.*` API behind capability flag.
2. TUI job UI (`/jobs`, wait mode backed by jobs).
3. `Ctrl+B` in-flight detach.
4. Optional deprecation path for direct blocking `shell.exec` behavior.

---

## 11. Related docs

- `docs/specs/backlog.md` (B-035)
- `docs/specs/tui-bang-shell-mode.md`
- `docs/specs/ui-protocol.md`
