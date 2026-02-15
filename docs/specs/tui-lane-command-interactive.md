# TUI `/lane` Interactive Command Spec

Status: `Proposed`

## 1. Goal

Replace the current `/lane` quick-guide output with an interactive flow that makes lane operations discoverable and executable from the TUI without manually crafting tool calls.

## 2. Desired UX

### 2.1 Entry behavior (`/lane`)

- Running `/lane` with no arguments opens lane list flow (default action).
- Existing quick-guide text is no longer the primary behavior.

### 2.2 Lane list view

- Fetch lanes via `lane_list {}`.
- Render selectable rows for each lane.
- Include lane summary fields at minimum:
  - `lane_id` (shortened display allowed)
  - `task_id`
  - `state`
  - `mux_backend`
- Include one extra row at the bottom: `+ New lane`.

### 2.3 Selected lane actions

When a lane row is selected:

1. Allow `Status` action:
   - Execute `lane_status { lane_id }`.
   - Show detailed result in panel/log.
2. Allow `Close` action from status context:
   - Execute `lane_close { lane_id }` (default `remove_worktree` behavior).
   - Reflect updated state in list after close attempt.

### 2.4 New lane creation action

When `+ New lane` is selected:

- Prompt for required creation input:
  - `task_id` (required)
- Prompt for optional instruction/context:
  - `seed_context` (optional free text)
- Execute `lane_create { task_id, seed_context? }`.
- On success:
  - Show created lane summary.
  - Show `hints.attach_command` when present.
  - Return to refreshed lane list.

## 3. Command semantics

- `/lane` accepts no positional arguments in this flow (keep `usage: /lane`).
- Unknown subcommands remain unsupported unless separately specified.

## 4. Error handling

- If `lane_list` fails: show an actionable error line and keep user in composer context.
- If `lane_status` or `lane_close` fails: preserve selection and render error details.
- If `lane_create` validation fails (e.g., empty task id): show inline validation error before tool call.

## 5. Integration constraints

- Respect existing TUI architecture boundaries:
  - command trigger in `handlers/command.rs`
  - state in `app/state/*`
  - rendering in `app/view/*`
- Do not add debug stdout logging.
- Use direct runtime tool invocation (`tool.call`) for lane operations in this flow.

## 6. Rollout notes

- This spec is additive and intentionally scoped to `/lane` only.
- Advanced options (`base_ref`, `worktree_path`, `mux_backend`, `force`) are out of scope for first interactive version.
- Future extension can add an advanced create/close dialog once baseline flow is stable.
