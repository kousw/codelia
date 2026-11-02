# TUI Input Queueing While Run Active (B-005)

Status: `Implemented` — in-memory TUI FIFO with no cross-process persistence.

This spec describes local TUI prompt queueing while a run is already active.
Current code: `crates/tui/src/app/handlers/command/prompt.rs`,
`crates/tui/src/app/handlers/command/queue.rs`, and
`crates/tui/src/app/app_state/mod.rs`.

## 1. Goal

- Prevent accidental prompt drops while `starting`/`running`/`awaiting_ui`.
- Preserve user submission order for multi-turn workflows.
- Provide explicit queue control (`retry`/`cancel`/`clear`) without interrupting the
  active run.

## 2. Non-goals

- Runtime/protocol wire changes in phase 1.
- Cross-process or cross-restart persistence of queued prompts.
- Complex queue editing (reorder, batch rewrite, dedup heuristics).

## 3. Current behavior

`start_prompt_run` snapshots and enqueues normal prompt submissions, then tries
to dispatch the oldest item when the run, RPC, dialog, and panel gates allow it.
When dispatch is blocked, the composer is available for the next draft and the
queue remains local to the current TUI process.

## 4. UX Contract

### 4.1 Queue on Enter while run is active

When user presses `Enter` for a normal prompt and run dispatch is blocked:

- enqueue the prompt as a queue item (FIFO)
- clear composer input/attachments for the next draft
- show status line in log, e.g. `Queued prompt q3 (queue=2)`

Queueing applies to normal prompt submission only, not slash command execution.

### 4.2 Automatic dequeue and dispatch

When the active run reaches terminal status (`completed`/`error`/`cancelled`),
and dispatch gate conditions are satisfied, TUI automatically sends the oldest
queued prompt as the next `run.start`.

Dispatch gate conditions:

- no active run (`!app.is_running()`)
- no pending run RPC (`pending_run_start_id` / `pending_run_cancel_id` absent)
- the head item is not paused after a dispatch failure
- no active confirm/prompt/pick dialog
- no modal panel state that would make auto-dispatch surprising

Only one queued item is dispatched at a time.

### 4.3 Queue management commands

The queue command surface is:

- `/queue`
  - show queue summary and first N entries (`id`, preview, age)
- `/queue retry`
  - resume dispatch of the paused head item, retaining its original payload
- `/queue cancel`
  - remove oldest queued prompt (next-to-send)
- `/queue cancel <id-or-index>`
  - remove one specific queued prompt
- `/queue clear`
  - remove all queued prompts

If queue is empty, commands return a status line (`queue is empty`).

### 4.4 Interaction with run cancellation

- Existing `Esc` / `Ctrl+C` active-run cancel behavior remains unchanged.
- Cancelling the active run does not clear queued prompts.
- Queue is controlled explicitly via `/queue retry|cancel|clear`.

### 4.5 Attachments and `!` shell result injection

Queued prompt content must be snapshotted at enqueue time:

- resolve final input text (including deferred `<shell_result>` prefix if any)
- resolve image tokens into `run.start` input payload (`type: text|parts`)
- store the fully prepared payload in queue item

This avoids coupling queued prompts to mutable composer state.

Effects:

- the prepared payload retains referenced images; the composer and its pending
  attachments are cleared after submission
- pending shell results are included in the snapshot and cleared at enqueue
- shell results that arrive after enqueue remain pending for a later prompt,
  including while the earlier `run.start` response is in flight
- later composer edits do not mutate already queued entries

## 5. State Model (TUI)

`AppState` holds:

- `pending_prompt_queue: VecDeque<PendingPromptRun>`
- `dispatching_prompt: Option<PendingPromptRun>`
- `next_prompt_queue_id: u64`
- optional retry/backoff marker for transient dispatch failures

`PendingPromptRun` fields (minimum):

- `queue_id: String` (`q1`, `q2`, ...)
- `queued_at: Instant`
- `preview: String` (single-line truncated)
- `input_payload: serde_json::Value` (final `run.start` input)
- `attachment_count: usize`
- `shell_result_count: usize`

## 6. Execution Flow

### 6.1 Enqueue path

In `start_prompt_run` caller path:

1. Build a submission snapshot from current composer state.
2. Push the snapshot into `pending_prompt_queue`; log queue status when blocked.
3. Attempt FIFO dispatch immediately when gates are open, and clear the composer.

### 6.2 Dispatch path

When dispatching queued item:

1. Move front item into `dispatching_prompt`.
2. Send `run.start` using stored `input_payload`.
3. On `run.start` success response:
   - clear `dispatching_prompt`
   - mark status `starting/running`.
4. On a `runtime busy` RPC response, restore the item to the queue front and
   retry with backoff. After five failed attempts, keep it paused at the front.
5. On a send failure, another RPC error, or a response without a run ID, retain
   the item and pause immediately. The run outcome can be uncertain; inspect
   whether it started before explicitly retrying.

### 6.3 Recovery behavior

- Paused items retain their input and attachments; `/queue` labels the head as
  paused. `/queue retry` resets its attempt count, and `/queue cancel` removes
  it so the next item can proceed.
- Queue survives active run cancel/failure and continues FIFO dispatch.
- Queue is best-effort in-memory only (discarded on process exit in phase 1).

## 7. Protocol / Runtime Impact

None required in phase 1.

- TUI remains responsible for queueing and dispatch timing.
- Runtime continues to process one active run at a time.

## 8. Observability and UI hints

- Status line (Info mode) includes queue size when `> 0`, e.g.
  `queue: 2`.
- Blocked enqueue and queue-management operations produce log messages;
  dispatch renders the submitted prompt.
- `/help` and slash command suggestions include `/queue` usage.

## 9. Test Plan

### 9.1 Unit tests

- Enqueue path while active run creates queue item and clears composer.
- Queue snapshot keeps payload stable even after composer mutation.
- `/queue retry`, `/queue cancel`, `/queue clear`, and empty-queue cases.
- Deferred shell result injection is consumed once when enqueueing.

### 9.2 Integration-like TUI loop tests

- `run A active -> enqueue B,C -> A completes -> B auto-start -> B completes -> C auto-start`.
- Cancel active run with queued items keeps queue intact.
- `runtime busy` responses pause the retained front item at the attempt limit;
  an uncertain send or result pauses immediately without automatic replay.

## 10. Implemented scope

FIFO queue state, `/queue` commands, the queue counter, and regression tests are
implemented. Durable or cross-process queueing remains outside this contract.

## 11. Related docs

- `dev-docs/specs/tui-operation-reference.md`
- `dev-docs/specs/tui-bang-shell-mode.md`
- `dev-docs/specs/ui-protocol.md`
