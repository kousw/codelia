# Lane Multiplexer Spec (Lite, worktree-first)

This document defines a minimal lane model for Codelia:
- create one `git worktree` per autonomous task
- launch one multiplexer lane (`tmux` or `zellij`) per worktree
- allow later human intervention as best-effort operations outside strict locking

The scope is intentionally limited to avoid feature sprawl.

---

## 1. Purpose

1. Make multi-task autonomous execution easy from one Codelia entrypoint.
2. Treat worktree isolation as the primary mechanism.
3. Keep lane lifecycle operations simple (`create/list/status/close/gc`).
4. Keep optional context injection small (`seed_context` text only).

---

## 2. Non-goals

1. Strict multi-lane coordination/locking model.
2. Shared same-session concurrent execution.
3. Interactive terminal attach via runtime tool calls.
4. Bundling `tmux`/`zellij` binaries into Codelia packages.

---

## 3. Terms

- `lane_id`: Codelia-managed execution lane ID.
- `task_id`: User-visible task key.
- `mux_backend`: `"tmux"` or `"zellij"`.
- `worktree_path`: lane-specific worktree directory.
- `session_id`: runtime conversation session ID.

Naming rule:
- Use `lane.*` for worktree/multiplexer orchestration.
- Keep `session.*` for conversation history semantics only.
- UI/user-facing text should prefer `Task lane (worktree slot)` on first mention.

---

## 4. Architecture (Lite)

```text
Codelia
  -> LaneManager
      -> WorktreeManager (git worktree)
      -> MuxAdapter (tmux/zellij)
      -> LaneRegistryStore
```

Responsibilities:
1. `LaneManager`: lane API orchestration and state updates.
2. `WorktreeManager`: create/remove/inspect worktrees.
3. `MuxAdapter`: backend-specific process commands.
4. `LaneRegistryStore`: persistent lane metadata/status.

---

## 5. Session Policy

1. `lane.create` defaults to **new session** (`fresh`).
2. Concurrent execution on the same `session_id` is not supported.
3. Passing text context to new lane is optional via `seed_context`.
4. `session.fork` is a separate feature area and not part of lane MVP.

---

## 6. Lane State Model

`lane.state`:
- `creating`
- `running`
- `finished`
- `error`
- `closed`

Rules:
1. `creating -> running` on successful startup.
2. Runtime completion moves lane to `finished` or `error`.
3. `closed` is terminal and set only by close/gc operation.

---

## 7. Data Model

```ts
export type LaneRecord = {
  lane_id: string;
  task_id: string;
  state: "creating" | "running" | "finished" | "error" | "closed";
  mux_backend: "tmux" | "zellij";
  mux_target: string;
  worktree_path: string;
  branch_name: string; // lane/<lane_id>
  session_id: string;  // fresh by default
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_error?: string;
};
```

---

## 8. API Surface (MVP)

1. `lane.create`
2. `lane.list`
3. `lane.status`
4. `lane.close`
5. `lane.gc`

### 8.1 `lane.create`

Input:
```ts
{
  task_id: string;
  base_ref?: string;
  worktree_path?: string; // optional override
  mux_backend?: "tmux" | "zellij";
  seed_context?: string; // optional, text only
}
```

Behavior:
1. Create worktree and lane branch.
   - Default worktree location: `~/.codelia/worktrees/<task-slug>-<lane-id8>`.
   - `worktree_path` is an optional explicit override (non-default).
2. Start backend lane.
3. Launch autonomous Codelia run in the lane.
4. Create fresh `session_id`.
5. If `seed_context` exists, pass it as initial text context.
   - Current implementation: append `--initial-message "<text>"` to lane launch command.
   - TUI waits for a send-safe state and auto-starts the first run.
6. Return operation hints in tool result (attach/status/close/worktree commands).

### 8.2 `lane.close`

Input:
```ts
{
  lane_id: string;
  remove_worktree?: boolean; // default true
  force?: boolean;           // default false
}
```

Behavior:
1. Explicit close only.
2. If lane is `running`, close should fail unless `force=true`.
3. If removing worktree, reject dirty worktree unless `force=true`.
4. Mark registry state as `closed`.

### 8.3 `lane.gc`

Input:
```ts
{
  idle_ttl_minutes: number;
  remove_worktree?: boolean; // default false
}
```

Behavior:
1. Target only `finished`/`error` lanes older than TTL.
2. Never close `running` lanes.
3. If `remove_worktree=true`, apply dirty guard unless force policy is explicitly enabled.

---

## 9. Multiplexer Backend Policy

1. Backend is selectable per lane (`tmux`/`zellij`).
2. Binaries are external dependencies resolved via PATH.
3. `lane.create` must run preflight and fail fast if backend is missing.

Implementation status (2026-02-14):
- Implemented: `tmux` backend.
- Planned: `zellij` backend command path.

---

## 10. Human Intervention Policy

1. Human can open the same worktree later (e.g., editor/terminal) without orchestration locks.
2. This is best-effort collaboration by design.
3. Lane system does not enforce strict writer ownership in MVP.

---

## 11. Safety Rules

1. `lane` operations use dedicated APIs/tools, not generic `bash`.
2. Never delete dirty worktree without explicit force.
3. Keep audit log entries for create/close/gc.

---

## 12. Canonical Errors

- `backend_not_found`
- `lane_not_found`
- `lane_running`
- `worktree_dirty`
- `backend_command_failed`

---

## 13. Acceptance Criteria

1. Multiple lanes run concurrently with separate worktrees.
2. `lane.gc` closes only stale finished/error lanes.
3. `lane.gc` never touches running lanes.
4. Missing `tmux`/`zellij` is reported before mutation.
5. Optional `seed_context` can initialize a fresh lane session.
