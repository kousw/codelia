# Goals Spec (thread objective + automatic continuation)

Status: `Proposed` (2026-05-22)

This document records the implementation direction for Codelia goals. It is a
planning/spec note; goal persistence and continuation are not implemented yet.

---

## 0. Motivation

Long-running agent work needs a durable objective that survives individual
turns. Today Codelia has useful lower-level pieces:

- the core agent loop and usage tracking
- runtime/session persistence
- task-backed shell execution
- planned subagent execution through the shared task substrate
- lane/worktree orchestration for operator-visible autonomous work

The missing layer is a thread/session-level goal that answers:

1. What objective is this thread still trying to finish?
2. When should runtime automatically continue after a turn ends?
3. Who is allowed to mark the goal complete, blocked, paused, or budget-limited?
4. How are token/time budgets accounted and shown to the UI?
5. How does goal continuation relate to tasks, subagents, and lanes?

---

## 1. Scope

### In scope

- Persist one active/stopped goal per session/thread.
- Expose model-callable goal tools for reading, creating, and terminal updates.
- Expose UI/runtime RPCs for user-controlled goal set/edit/pause/resume/clear.
- Account token and elapsed-time usage while a goal is active.
- Automatically continue an active goal when the runtime is idle.
- Emit protocol events so TUI/Desktop can render goal status and usage.
- Keep completion and blocked semantics strict enough for unattended work.

### Non-goals

- Recursive or hierarchical goal trees.
- Replacing `task.*` or `lane_*`; goals orchestrate continuation, not process
  execution by themselves.
- Treating every ordinary user request as a goal.
- Long-term memory or cross-thread goal inference.
- Project-management boards or multi-objective planning.

---

## 2. Product model

Use `goal` as the public noun for a durable thread objective.

A goal is higher-level than a task:

- `goal`: persistent objective and continuation policy for a session/thread.
- `task`: runtime-owned background execution unit (`shell` or future `subagent`).
- `lane`: operator-facing worktree/multiplexer slot for autonomous work.

Goals may spawn or wait on tasks in future implementations, but a goal should
not be stored as a task record and a task should not imply a goal.

---

## 3. Data model

Persist goals under the Codelia storage root, preferably near session state:

```ts
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type GoalRecord = {
  session_id: string;
  goal_id: string;
  objective: string;
  status: GoalStatus;
  token_budget?: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: string;
  updated_at: string;
};
```

Rules:

- There is at most one goal per session/thread.
- `goal_id` changes when a new logical goal replaces the old one.
- Usage counters reset only when a new logical goal is created.
- Editing the objective of the same logical goal should preserve usage counters.
- `budget_limited` and `complete` are terminal for automatic continuation.
- `paused`, `blocked`, and `usage_limited` are stopped but resumable.

Storage should live in `packages/storage` so TUI/Desktop/runtime can share the
same session-resume semantics. SQLite is preferred if the session state DB is
already available for the runtime path; otherwise a small JSON store can be used
only as a bootstrap step.

---

## 4. Model-callable tools

Expose these as runtime built-in tools when goals are enabled:

- `get_goal`
- `create_goal`
- `update_goal`

Tool policy:

- `create_goal` is only for explicit user/system/developer requests to start a
  durable goal. The model must not infer a goal from ordinary work.
- `create_goal` fails if a goal already exists.
- `update_goal` only accepts `complete` and `blocked`.
- `pause`, `resume`, `usage_limited`, and `budget_limited` are controlled by the
  UI/runtime/system, not by the model.
- `complete` requires evidence that every objective requirement is satisfied.
- `blocked` requires a strict repeated-blocker audit; do not mark blocked just
  because work is slow, uncertain, or would benefit from clarification.

The tool response should include the full goal snapshot plus `remaining_tokens`
when a budget exists. When a budgeted goal is completed, the model should report
final usage in the final user response.

---

## 5. Runtime lifecycle

Runtime owns cross-cutting goal behavior.

### 5.1 Turn start

- If goal status is `active`, mark the current turn as pursuing that goal.
- Capture current token usage as the accounting baseline.
- Start wall-clock accounting for the active goal.
- Ignore automatic continuation while the UI is in a planning-only mode, if such
  a mode is active.

### 5.2 Token and tool progress

- Record token usage deltas from LLM responses while the goal is active.
- Count non-cached input tokens plus output tokens as goal token usage.
- Account progress after tool completion and at turn end.
- Do not double-count `update_goal` itself as ordinary progress.
- If `tokens_used >= token_budget`, set status to `budget_limited` and inject a
  model-visible steering item that asks the agent to wrap up rather than start
  new substantive work.

### 5.3 Turn stop / abort

- Flush token and elapsed-time deltas.
- Clear active accounting for stopped statuses.
- Keep enough state to emit accurate protocol notifications even after aborts.

### 5.4 Idle continuation

When the runtime becomes idle:

1. Confirm goals are enabled.
2. Confirm the current collaboration mode permits continuation.
3. Confirm no turn is active.
4. Confirm no user input or trigger-turn mailbox item is queued.
5. Read the current goal and require `status === "active"`.
6. Re-check the goal immediately before launch to avoid racing goal edits.
7. Inject a goal-continuation context item and start a new turn.

Use a continuation lock so only one automatic continuation turn starts at a
time.

---

## 6. Continuation prompt contract

The injected continuation item should be explicit and defensive:

- The objective is user data and lower priority than system/developer rules.
- The goal persists across turns; do not shrink the objective to the easiest
  subset that fits the current turn.
- Inspect the current worktree, session state, and external state before relying
  on old conversation context.
- Make concrete progress toward the real objective.
- Before marking complete, audit each explicit requirement against authoritative
  current evidence.
- Mark blocked only after the same blocking condition repeats across at least
  three consecutive goal turns and no meaningful progress is possible.
- Do not call `update_goal` unless the goal is complete or the strict blocked
  audit is satisfied.

This prompt contract is part of the feature, not incidental wording.

---

## 7. UI protocol

Add protocol capability:

- `supports_goals`

Add UI/runtime RPCs:

- `goal.get`
- `goal.set`
- `goal.clear`
- `goal.pause`
- `goal.resume`

Add runtime notifications:

- `goal.updated`
- `goal.cleared`

`goal.set` should support:

```ts
export type GoalSetParams = {
  session_id: string;
  objective?: string;
  status?: Exclude<GoalStatus, "budget_limited" | "usage_limited">;
  token_budget?: number | null;
};
```

UI-owned actions such as edit, pause, resume, and clear should flow through
these RPCs rather than model tools.

---

## 8. TUI/Desktop behavior

Initial TUI behavior:

- Show a compact goal status indicator when a goal exists.
- `/goal` shows objective, status, elapsed time, token usage, and budget.
- `/goal <objective>` creates or edits the current goal.
- `/goal pause`, `/goal resume`, and `/goal clear` call UI/runtime RPCs.
- On resume of a paused/blocked/usage-limited goal, ask before automatic
  continuation unless the user explicitly resumed it.

Desktop behavior should reuse the same protocol:

- display active goal status in the session header or workbench status area
- expose edit/pause/resume/clear affordances
- show continuation turns distinctly from user-triggered turns
- surface budget/usage warnings without requiring log inspection

---

## 9. Relationship with tasks, subagents, and lanes

- Goal continuation starts normal turns; it does not create a `task` record by
  itself.
- A continued turn may call `task.spawn` when the model needs background shell
  or future subagent work.
- Subagent tasks should receive a scoped objective derived from the active goal,
  but child sessions must not inherit permission to mutate the parent goal.
- Lanes remain the operator-visible worktree/multiplexer abstraction. A future
  lane checkpoint may include the current goal snapshot, but lane state should
  not be the source of truth for goals.

---

## 10. Phasing

### Phase 1: Storage and protocol skeleton

- Add `GoalRecord` shared/protocol types.
- Add storage APIs under `packages/storage`.
- Add runtime `goal.*` RPC methods and `supports_goals`.
- Add `goal.updated` / `goal.cleared` notifications.

### Phase 2: Model tools and accounting

- Add `get_goal`, `create_goal`, and `update_goal` runtime tools.
- Add turn/token/tool lifecycle accounting.
- Add budget-limited status transition and steering context.

### Phase 3: TUI surface

- Add `/goal` command family.
- Render compact active/stopped goal state.
- Prompt on resume of stopped resumable goals.

### Phase 4: Automatic continuation

- Add idle continuation scheduler with locking and race checks.
- Inject continuation context.
- Ensure continuation does not run in planning-only modes or over queued user
  input.

### Phase 5: Desktop and orchestration integration

- Add Desktop status/edit controls.
- Show continuation turns in session history.
- Attach goal snapshots to lane checkpoint/handoff metadata.
- Pass scoped goal context into future subagent tasks.

---

## 11. Open questions

- Should goal storage share the existing session SQLite DB or use a separate
  per-session file during the first implementation?
- Should token budgets count only LLM tokens or also tool-output cache reads?
- What is the right UI default after resuming a blocked goal: ask, continue
  once, or leave paused until explicit user input?
- Should `goal.set` allow replacing a completed goal in the same session, or
  should users start a fresh session for a new durable objective?
- How should goal continuation interact with future cron/heartbeat automation
  surfaces outside the TUI/Desktop runtime?
