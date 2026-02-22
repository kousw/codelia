# TUI Input Queueing While Run Active (B-005)

Status: `Planned`

This spec defines how the TUI should queue prompt submissions while a run is
already active.

## 1. Goal

- Prevent accidental prompt drops while `starting`/`running`/`awaiting_ui`.
- Preserve user submission order for multi-turn workflows.
- Provide explicit queue control (`cancel`/`clear`) without interrupting the
  active run.

## 2. Non-goals

- Runtime/protocol wire changes in phase 1.
- Cross-process or cross-restart persistence of queued prompts.
- Complex queue editing (reorder, batch rewrite, dedup heuristics).

## 3. Current behavior (baseline)

Today, `start_prompt_run` rejects submission when a run is active (or
`pending_run_start_id` / `pending_run_cancel_id` is set), and the TUI shows:

- `Run is still active; wait for completion before sending the next prompt.`

B-005 replaces this rejection path for normal prompt submission with local
queueing.

## 4. UX Contract

### 4.1 Queue on Enter while run is active

When user presses `Enter` for a normal prompt and run dispatch is blocked:

- enqueue the prompt as a queue item (FIFO)
- clear composer input/attachments for the next draft
- show status line in log, e.g. `Queued prompt #3 (queue=2)`

Queueing applies to normal prompt submission only, not slash command execution.

### 4.2 Automatic dequeue and dispatch

When the active run reaches terminal status (`completed`/`error`/`cancelled`),
and dispatch gate conditions are satisfied, TUI automatically sends the oldest
queued prompt as the next `run.start`.

Dispatch gate conditions:

- no active run (`!app.is_running()`)
- no pending run RPC (`pending_run_start_id` / `pending_run_cancel_id` absent)
- no active confirm/prompt/pick dialog
- no modal panel state that would make auto-dispatch surprising

Only one queued item is dispatched at a time.

### 4.3 Queue management commands

Add queue command surface:

- `/queue`
  - show queue summary and first N entries (`id`, preview, age)
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
- Queue is controlled explicitly via `/queue cancel|clear`.

### 4.5 Attachments and `!` shell result injection

Queued prompt content must be snapshotted at enqueue time:

- resolve final input text (including deferred `<shell_result>` prefix if any)
- resolve image tokens into `run.start` input payload (`type: text|parts`)
- store the fully prepared payload in queue item

This avoids coupling queued prompts to mutable composer state.

Effects:

- pending image attachments referenced by queued text are consumed for that item
- pending shell results are consumed exactly once by the first queued/started
  normal prompt
- later composer edits do not mutate already queued entries

## 5. State Model (TUI)

Add to `AppState`:

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
2. If dispatch is blocked by active run/pending run RPC:
   - push snapshot into `pending_prompt_queue`
   - log queue status
   - return success to clear composer.
3. Otherwise dispatch immediately (existing path).

### 6.2 Dispatch path

When dispatching queued item:

1. Move front item into `dispatching_prompt`.
2. Send `run.start` using stored `input_payload`.
3. On `run.start` success response:
   - clear `dispatching_prompt`
   - mark status `starting/running`.
4. On send/RPC error:
   - restore `dispatching_prompt` to queue front
   - show error
   - retry on next eligible loop/tick (with short backoff).

### 6.3 Recovery behavior

- `runtime busy` (race) does not drop queue items.
- Queue survives active run cancel/failure and continues FIFO dispatch.
- Queue is best-effort in-memory only (discarded on process exit in phase 1).

## 7. Protocol / Runtime Impact

None required in phase 1.

- TUI remains responsible for queueing and dispatch timing.
- Runtime continues to process one active run at a time.

## 8. Observability and UI hints

- Status line (Info mode) should include queue size when `> 0`, e.g.
  `queue: 2`.
- Log lines should be explicit for enqueue/dequeue/cancel/clear operations.
- `/help` and slash command suggestions should include `/queue` usage.

## 9. Test Plan

### 9.1 Unit tests

- Enqueue path while active run creates queue item and clears composer.
- Queue snapshot keeps payload stable even after composer mutation.
- `/queue cancel`, `/queue clear`, and empty-queue cases.
- Deferred shell result injection is consumed once when enqueueing.

### 9.2 Integration-like TUI loop tests

- `run A active -> enqueue B,C -> A completes -> B auto-start -> B completes -> C auto-start`.
- Cancel active run with queued items keeps queue intact.
- `run.start` dispatch error requeues front item without loss.

## 10. Rollout

1. Implement queue state + enqueue/dequeue flow with FIFO.
2. Add `/queue` command surface and status line queue counter.
3. Add tests and update operation docs.

## 11. Related docs

- `docs/specs/backlog.md` (B-005)
- `docs/specs/tui-operation-reference.md`
- `docs/specs/tui-bang-shell-mode.md`
- `docs/specs/ui-protocol.md`
