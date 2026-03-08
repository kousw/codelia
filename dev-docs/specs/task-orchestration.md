# Task Orchestration Spec (background tasks + subagents)

Status: `Proposed` (2026-03-07)

This spec defines a unified orchestration model for long-running shell work and delegated child-agent execution while keeping the main Codelia session usable.

---

## 0. Motivation

Current background work is split conceptually:

- Bang shell background execution is planned as a job model (`shell.*`).
- Lane execution already supports autonomous multi-task work with worktree-based workspace separation.
- Subagents are listed in backlog as a bounded delegated-execution feature.

The missing piece is a single orchestration model that answers:

1. What is the public noun: `task`, `job`, or `agent`?
2. How can background work continue while the main session keeps running?
3. How should long-running shared-workspace writes such as install/setup be handled safely?
4. How are child sessions isolated from the parent session?
5. How are running child processes cleaned up so they do not linger after runtime exit?

This spec proposes a common substrate and public terminology that shell background execution and subagent execution can share.

---

## 1. Naming decision

### 1.1 Public term: `task`

Use `task` as the primary public/user-facing orchestration noun.

Rationale:

- `job` sounds implementation-centric and process-centric.
- `agent` is already overloaded with the LLM execution entity itself.
- `task` matches user intent better: "run this in the background", "delegate this", "check task status".

Examples:

- `Started background task <task_id>`
- `/tasks`
- `task_spawn`, `task_status`, `task_wait`, `task_cancel`

### 1.2 Internal term: `task`

Use `task` internally as well.

Rationale:

- Using `task` in both the public API and internal orchestration model keeps storage, manager, and UI vocabulary aligned.
- Avoiding a separate internal noun like `job` reduces translation overhead when debugging state transitions.
- A future retry/restart model can still be expressed as multiple attempts within one task record without renaming the primary abstraction.

Examples:

- `TaskRecord`
- `TaskManager`
- `task_id`
- `task.state`

### 1.3 Executor term: `TaskExecutor`

Use `TaskExecutor` (or concrete names like `shell executor` / `subagent executor`) for the implementation that runs a task.

Examples:

- `ShellTaskExecutor`
- `SubagentTaskExecutor`
- `child runtime process`

`TaskExecutor` is an implementation-side term and should not replace `task` as the main persisted/runtime abstraction.

### 1.4 Reserved term: `agent`

Use `agent` only for the LLM executor kind or runtime entity.

Examples:

- `task.kind = "subagent"`
- `child runtime process running an agent`
- `Agent` class / runtime session

---

## 2. Scope / Non-goals

### In scope

- A shared task substrate for background shell work and delegated subagents.
- Public lifecycle operations for tasks (`spawn/list/status/wait/cancel/result`).
- Session ownership rules for parent and child execution.
- Concurrency rules for multiple running tasks.
- Cleanup/shutdown behavior so owned child processes do not linger.
- Workspace execution modes for live-workspace best-effort coordination and planned worktree-backed separation.

### Non-goals (initial)

- Recursive subagents (`child -> grandchild`).
- Arbitrary DAG scheduling / task dependencies.
- Full PTY attach for generic tasks.
- Cross-machine distributed execution.
- Perfect locking against human edits outside Codelia.

---

## 3. Design summary

Use a shared runtime-owned `TaskManager` as the orchestration layer.

```text
Codelia Runtime
  -> TaskManager
      -> TaskRegistryStore
      -> ShellTaskExecutor
      -> SubagentTaskExecutor
      -> WorktreeManager (planned follow-up for workspace_mode=worktree)
```

Key rules:

1. Every long-running backgroundable execution is represented as a `task`.
2. The main session stays usable while a task is running.
3. Each subagent task uses a fresh child session.
4. Live-workspace mutation is allowed and treated as best-effort coordination, similar to running multiple long shell commands in the same workspace.
5. Runtime owns the executor processes it creates and must clean them on exit.

### 3.1 Class diagram (MVP substrate)

```mermaid
classDiagram
  class Runtime {
    +runtime_id
    +owner_pid
    +recoverOrphanedTasks()
    +shutdown()
  }

  class TaskManager {
    +spawn()
    +list()
    +status()
    +wait()
    +cancel()
    +result()
    +recoverOrphanedTasks()
    +shutdown()
  }

  class TaskRegistryStore {
    +list()
    +get(task_id)
    +upsert(record)
    +patch(task_id, patch)
  }

  class TaskRecord {
    +task_id
    +kind
    +workspace_mode
    +state
    +owner_runtime_id
    +owner_pid
    +executor_pid
    +executor_pgid
    +created_at
    +started_at
    +ended_at
    +result
    +failure_message
    +cancellation_reason
    +cleanup_reason
  }

  class TaskExecutionHandle {
    +metadata
    +wait
    +cancel()
  }

  class ShellTaskExecutor {
    +start(task) TaskExecutionHandle
  }

  class SubagentTaskExecutor {
    +start(task) TaskExecutionHandle
  }

  class WorktreeManager {
    <<planned>>
  }

  Runtime --> TaskManager : owns
  TaskManager --> TaskRegistryStore : persists via
  TaskRegistryStore --> TaskRecord : stores
  TaskManager --> TaskExecutionHandle : tracks active
  TaskManager ..> ShellTaskExecutor : delegates shell tasks
  TaskManager ..> SubagentTaskExecutor : delegates subagent tasks
  TaskManager ..> WorktreeManager : future worktree mode
```

### 3.2 Sequence diagram: spawn -> wait -> complete

```mermaid
sequenceDiagram
  participant U as User/UI
  participant R as Runtime
  participant TM as TaskManager
  participant TR as TaskRegistryStore
  participant EX as TaskExecutor

  U->>R: start long-running shell/subagent work
  R->>TM: spawn(input, startExecution)
  TM->>TR: upsert(task state=queued)
  TM->>EX: start(task)
  EX-->>TM: TaskExecutionHandle(metadata, wait, cancel)
  TM->>TR: patch(task state=running, started_at, executor ids)
  TM-->>R: task_id
  R-->>U: started task / optionally attach wait

  U->>R: task_wait(task_id)
  R->>TM: wait(task_id)
  EX-->>TM: terminal outcome
  TM->>TR: patch(task terminal state, ended_at, result)
  TM-->>R: terminal TaskRecord
  R-->>U: summary/result
```

### 3.3 Sequence diagram: startup recovery of orphaned tasks

Recovery is cleanup-only. It must not re-run shell commands or restart child agents.

```mermaid
sequenceDiagram
  participant NR as New Runtime
  participant TM as TaskManager
  participant TR as TaskRegistryStore
  participant OS as OS / process table

  NR->>TM: recoverOrphanedTasks()
  TM->>TR: list()
  loop each queued/running task
    TM->>OS: is owner_pid alive?
    alt owner still alive
      TM-->>TM: leave task unchanged
    else owner is dead
      opt executor_pid / executor_pgid persisted
        TM->>OS: best-effort terminate executor
      end
      TM->>TR: patch(task state=cancelled,
                     cancellation_reason="owner runtime exited unexpectedly",
                     cleanup_reason="owner runtime exited unexpectedly")
    end
  end
```

---

## 4. Task kinds and workspace modes

### 4.1 Task kinds

MVP task kinds:

- `shell`
- `subagent`

Notes:

- `shell` covers bang-style or future direct shell background runs.
- `subagent` covers delegated child-agent execution with bounded scope.

### 4.2 Workspace modes

Tasks declare one workspace mode.

#### `live_workspace`

- Uses the current workspace/cwd.
- Intended to behave like running multiple long shell commands in the same workspace.
- Best-effort coordination only.
- No strict conflict guarantee is provided.
- Writes are allowed if the delegated permission envelope permits them.

#### `worktree`

- Uses a dedicated git worktree.
- Intended for stronger workspace separation and conflict avoidance.
- Planned follow-up, not part of MVP.

### 4.3 Recommended defaults

- `shell`: default to `live_workspace`.
- `subagent`: default to `live_workspace`.
- `worktree`: keep as planned follow-up for edit-heavy delegated tasks.

The important point is to be explicit that MVP uses live-workspace best-effort coordination rather than promising strict isolation.

### 4.4 Foreground wait vs background detach

Long-running execution should still be task-backed even when the user experiences it as foreground work.

Rules:

1. Starting a long-running shell/subagent operation in foreground creates a `task` first.
2. Foreground behavior is implemented as `wait on task`, not as a separate non-task execution path.
3. UI may detach from that wait and send the task to background without restarting it.
4. `Ctrl+B` is the canonical in-flight detach gesture while the UI is actively waiting on a task.
5. After detach, the main session returns to normal interaction while the same task continues running.

In other words, the important split is not foreground vs background execution, but attached wait vs detached wait over the same underlying task.

---

## 5. Session policy

### 5.1 Parent session remains the main conversational session

The currently attached TUI/runtime session remains the parent session.

- It stays interactive while tasks run.
- It records only spawn/wait/result summaries for child tasks.
- It does not absorb full child history by default.

### 5.2 Child session is always fresh for subagents

Each `subagent` task gets a fresh child `session_id`.

Rationale:

- Current runtime does not support concurrent execution on the same session.
- Parent and child history must remain auditable and isolated.
- Cancellation and completion should not mutate the parent history structure unexpectedly.

### 5.3 Parent-child linkage

Store linkage metadata on the task record:

- `parent_session_id`
- `parent_run_id?`
- `parent_tool_call_id?`
- `child_session_id?`

### 5.4 Result injection policy

- If the caller waits, return a structured summary/artifact result directly.
- If the task continues in background, completion does not automatically inject child history into the parent session.
- Later turns may call `task_result` or `task_wait` explicitly.

This avoids uncontrolled context pollution.

### 5.5 Subagent permission model

Subagent permission must be decided at spawn time, not interactively inside the child executor.

Rationale:

- Current permission policy defaults unknown actions to `confirm`.
- When UI confirm is unavailable, `confirm` becomes `deny`.
- A headless child runtime therefore cannot safely rely on normal nested permission prompts.

MVP rule:

- `task_spawn(kind="subagent")` establishes a delegated permission envelope.
- The parent runtime/operator approves that envelope once.
- The child executor runs non-interactively within that envelope.
- Any tool call outside the envelope is hard-denied inside the child.

The delegated permission envelope should include at minimum:

- `tool_allowlist`
- optional bash command allowlist / narrowed prefixes
- workspace mode (`live_workspace` / `worktree`)
- workspace/path scope
- step/time budget
- parent approval snapshot metadata

Policy notes:

- Child executors must not request new UI confirms on their own.
- Child executors must not widen their own permission envelope.
- Remember/allow behavior should attach to the parent `task_spawn` decision, not to hidden child-internal tool calls.
- `approval_mode=full-access` may auto-allow spawn, but the child should still be bounded by its explicit delegated envelope.

### 5.6 Delegated permission envelope (implementation sketch)

```ts
type DelegatedTaskPermission = {
  mode: "delegated";
  task_id: string;
  task_kind: "subagent";
  tool_allowlist: string[];
  bash_allow?: Array<{
    command?: string;
    command_glob?: string;
  }>;
  workspace_mode: "live_workspace" | "worktree";
  workspace_root: string;
  max_steps?: number;
  timeout_seconds?: number;
};
```

Implementation rules:

- Child runtime permission evaluation must treat this envelope as a hard cap.
- Anything outside the delegated allowlist is `deny`, not `confirm`.
- Existing explicit deny rules still win over delegated allow rules.
- Child runtime must not persist new remembered allow rules from delegated execution.
- Parent runtime is responsible for presenting a human-readable summary of the delegated envelope before approval when confirmation is required.

---

## 6. Concurrency and integrity policy

### 6.1 Runtime-level ownership

A task is owned by the runtime instance that created it.

Store ownership/persistence fields:

- `owner_runtime_id`
- `owner_pid`
- `executor_pid?`
- `executor_pgid?`
- `child_session_id?`

For runtime-owned spawned executors, `executor_pid` / `executor_pgid` must be persisted so crash recovery can identify and terminate orphaned child processes from a later runtime instance.

The owning runtime is responsible for:

- status transitions
- cancellation
- final result capture
- cleanup on exit

### 6.2 Registry update serialization

`TaskRegistryStore` writes must be coordinated through `TaskManager`, but process-local serialization alone is not sufficient.

Reason:

- Multiple tasks may finish or emit status updates concurrently inside one runtime.
- Different runtimes may also inspect/recover/update task records.
- A single shared read-modify-write JSON blob risks lost updates across runtimes.

MVP requirement:

- One in-process async write queue around registry mutation inside each runtime.
- Multi-runtime-safe persistence on top of that, for example per-task files or another compare-and-swap/storage-backed approach.
- Atomic replacement still applies at the file/object level used by the chosen persistence layout.

### 6.3 Live workspace coordination

`live_workspace` tasks are best-effort by design.

MVP rules:

1. Codelia does not promise strict conflict prevention between concurrent live-workspace tasks.
2. Running multiple tasks in the same workspace is treated similarly to running multiple long shell commands in parallel.
3. Runtime should keep task state visible and make cancellation/detach/result retrieval reliable.
4. Stronger workspace separation is deferred to planned `worktree` support.

### 6.4 Best-effort human coexistence

Codelia does not attempt to hard-lock human edits in another terminal/editor.

Policy:

- Expose active tasks clearly in UI/logs.
- Treat both human and automated concurrent mutation in the live workspace as best-effort collaboration.
- Recommend `worktree` mode in future phases when stronger separation is needed.

---

## 7. Lifecycle and shutdown semantics

### 7.1 Task states

Public task states:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`

MVP keeps the public state model simple.

### 7.2 Normal completion

On success or terminal failure:

- capture final summary/result metadata
- capture output/cache refs when applicable
- mark terminal state
- record `ended_at`

### 7.3 Cancellation

`task_cancel` is best-effort and idempotent.

Cancellation behavior:

- Shell task: terminate owned process group where supported.
- Subagent task: cancel child runtime request first; if it does not exit within grace period, terminate the child process group.

### 7.4 Runtime shutdown

Default cleanup policy for runtime-owned tasks is `cancel_on_owner_exit`.

On normal runtime shutdown:

1. stop accepting new task spawns
2. send cancellation to all running owned tasks
3. wait up to a short grace period
4. force-kill remaining owned process groups
5. mark unfinished owned tasks as `cancelled` with cleanup reason

This avoids background tasks lingering and interfering after the parent runtime exits.

### 7.5 Crash or unclean exit recovery

On startup, `TaskManager` should scan the registry for running tasks owned by dead runtimes.

Recovery behavior:

- if owner PID is gone, mark the task terminal with a cleanup reason such as `owner runtime exited unexpectedly`
- if persisted `executor_pid` / `executor_pgid` still exists, best-effort terminate it before finalizing the record
- if executor identifiers were never persisted, crash-recovery cleanup is considered incomplete and the implementation does not satisfy this spec

The goal is that stale tasks do not remain forever in `running` state.

### 7.6 Result retention / GC

Task metadata and result references should be retained for a bounded period.

Recommended MVP policy:

- keep recent terminal tasks in the registry
- allow explicit `task_gc` later or reuse time-window pruning internally
- never delete running tasks through retention GC

---

## 8. Public surface

### 8.1 Agent-facing tool family

Prefer a unified task tool family for model/tool-call usage:

- `task_spawn`
- `task_list`
- `task_status`
- `task_wait`
- `task_cancel`
- `task_result`

`task_wait` represents an attached wait on an already-created task. This is the primitive that foreground UX should use under the hood.

Approval boundary rule:

- `task_spawn(kind="shell")` is still an agent/tool-call path and follows normal task/tool permission evaluation.
- UI-origin shell RPCs (`shell.exec`, future `shell.start`/`shell.wait`) may keep their existing `origin=ui_bang` no-confirm exception.
- Sharing one task substrate must not allow the UI-only shell bypass to leak into agent-originated shell tasks.

`task_spawn` input sketch:

```ts
{
  kind: "shell" | "subagent";
  background?: boolean; // default true when long-running, false when caller wants inline wait
  workspace_mode?: "live_workspace" | "worktree";

  // shell
  command?: string;

  // subagent
  prompt?: string;
  tool_allowlist?: string[];
  max_steps?: number;

  timeout_seconds?: number;
}
```

### 8.2 UI/runtime RPC compatibility

For TUI bang-shell flow, `shell.*` RPC methods may remain as TUI-specific compatibility aliases, but the main orchestration surface should be `task_*` and both paths should use the same task substrate underneath.

Compatibility rule:

- `shell.start` returns `task_id` even if historical drafts called it `job_id`
- `shell.exec` may wrap `shell.start + shell.wait`
- `shell.*` should be treated as a compatibility/UI-facing path, not the primary general-purpose orchestration API

Detach/wait wire requirement:

- `Ctrl+B` acceptance requires an explicit protocol method that detaches wait without cancelling the underlying task.
- This can be expressed as `shell.detach { task_id }` for the shell compatibility path or a future generic `task.detach { task_id }`.
- Until such a method is added to `packages/protocol`/`ui-protocol`, detach remains a planned protocol extension rather than an already-specified wire behavior.

### 8.3 Result shape

`task_result` / `task_wait` should return structured output.

```ts
{
  task_id: string;
  kind: "shell" | "subagent";
  state: "completed" | "failed" | "cancelled";
  summary?: string;
  stdout?: string;
  stderr?: string;
  stdout_cache_id?: string;
  stderr_cache_id?: string;
  child_session_id?: string;
  worktree_path?: string;
  artifacts?: Array<{
    type: "file" | "patch" | "json";
    path?: string;
    ref?: string;
    description?: string;
  }>;
}
```

MVP for subagent may return `summary` only, while preserving room for artifacts.

---

## 9. Executor-specific behavior

### 9.1 ShellTaskExecutor

- Reuse current shell runner and sandbox rules.
- Capture stdout/stderr incrementally.
- Persist large output via tool-output cache.
- Support wait and later result retrieval.

### 9.2 SubagentTaskExecutor

Use a child runtime process, not an in-process nested run.

Rationale:

- Current runtime is single-active-run oriented.
- Child history/session separation is simpler.
- Cleanup ownership is explicit.
- Parent session remains free to continue.

MVP rules:

- child runtime is non-recursive for `task_spawn`
- child session is fresh
- child uses explicit tool allowlist and bounded budgets
- parent receives only summary/result metadata, not child event stream replay

#### 9.2.1 Parent-side execution flow

1. Parent runtime receives `task_spawn(kind="subagent")`.
2. Parent runtime resolves/approves the delegated permission envelope.
3. Parent runtime allocates `task_id` and fresh `child_session_id`.
4. Parent runtime spawns a child runtime process over stdio.
5. Parent runtime installs delegated permission state into the child runtime before `run.start`.
6. Parent runtime sends `initialize` and `run.start` for the child prompt.
7. Parent runtime tracks `run.status` / final output and writes terminal task state.
8. Parent runtime stores summary/result metadata for `task_wait` / `task_result`.

#### 9.2.2 Cancellation and failure handling

- `task_cancel` first maps to child `run.cancel`.
- If the child runtime does not exit within grace period, parent force-kills the child process group.
- If child startup fails before `run.start`, mark task `failed` with startup error.
- If parent runtime exits, normal shutdown policy applies (`cancel_on_owner_exit`).

### 9.3 Worktree-backed subagent execution (planned follow-up)

When `workspace_mode=worktree`:

- create a dedicated worktree before launching the child runtime
- associate `worktree_path` and branch metadata with the task record
- do not auto-merge into the parent workspace

This is not part of MVP. Human attach/promotion to lane is a separate concern.

---

## 10. Relationship with lane

Lane and task orchestration solve adjacent but different problems.

- `task_*`: agent-facing delegated execution and background tracking
- `lane_*`: operator-facing autonomous lane/worktree management

Shared components are encouraged:

- worktree creation/removal helpers
- registry persistence patterns
- cleanup/GC patterns
- handoff/checkpoint metadata

But `lane` should not be the MVP implementation mechanism for `subagent` tasks because it is optimized for human-attach flows rather than structured parent-child result handling.

---

## 11. Resolved design decisions

- Naming: use `task` everywhere as the primary orchestration noun.
- Foreground detach model: all long-running execution is task-backed; foreground is attached wait over a task.
- Public MVP surface: `task_*` is the main orchestration API. `shell.*` remains only as TUI/bang compatibility aliases.
- Workspace mode: `live_workspace` is the MVP default and is explicitly best-effort. `worktree` is a planned follow-up, not part of MVP.
- Subagent permission: use spawn-time delegated permission envelopes.
- Session policy: subagent execution always uses a fresh child session. Explicit child-session resume is a follow-up question.
- Live-workspace coordination: no strict conflict-prevention guard in MVP.
- Shutdown policy: `cancel_on_owner_exit`.

## 12. Rollout plan

### Phase 1: Task substrate

- `TaskRegistryStore`
- `TaskManager`
- `TaskExecutionHandle` / executor ownership tracking
- state transitions
- cancel/wait/status/result retention
- owner-runtime cleanup on exit/startup recovery

### Phase 2: Shell tasks

- `shell.start/list/status/output/cancel/wait` as TUI/bang compatibility aliases over the task substrate
- implement on top of task substrate
- make `shell.exec` a wrapper
- foreground shell wait is task-backed, not a separate code path
- `Ctrl+B` detaches active wait to background
- TUI `/tasks` or equivalent later

### Phase 3: Subagent tasks

- `task_spawn/list/status/wait/cancel/result` for `kind="subagent"`
- child runtime process executor
- non-recursive
- explicit tool allowlist + budgets
- summary-only result initially

### Phase 4: Worktree-backed tasks (planned follow-up)

- `workspace_mode="worktree"`
- shared worktree helper extraction
- result metadata includes worktree/branch info

### Phase 5: Optional lane promotion / richer artifacts

- explicit handoff from task to lane when human attach is desired
- artifact manifests, patch refs, checkpoint metadata

---

## 13. Acceptance criteria

1. A long-running shell task can continue while the main session remains usable.
2. A delegated subagent task can continue while the main session remains usable.
3. Foreground wait for a long-running task is implemented as attached wait over a task-backed execution, not a separate execution path.
4. The user can detach an active wait with `Ctrl+B` and continue using the main session while the same task keeps running.
5. Runtime-owned background tasks do not remain indefinitely after normal runtime exit.
6. Stale running tasks from dead runtimes are recoverable and do not remain forever in `running` state.
7. Live-workspace task execution is explicitly documented as best-effort and does not promise strict conflict prevention.
8. Subagent tasks do not execute concurrently in the same child session as the parent.
9. Parent session receives bounded summaries/results rather than uncontrolled child transcript injection.

---

## 14. Related docs

- `dev-docs/specs/shell-background-execution.md`
- `dev-docs/specs/lane-multiplexer.md`
- `dev-docs/specs/tui-bang-shell-mode.md`
- `dev-docs/specs/ui-protocol.md`
- `dev-docs/specs/backlog.md` (`B-030`, `B-035`)
