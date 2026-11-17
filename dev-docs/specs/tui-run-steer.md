# TUI / Runtime Mid-Run Steer with Queue Fallback

Status: `Implemented` — extends [`tui-input-queueing.md`](./tui-input-queueing.md).
Evidence: `packages/shared-types/src/content.ts`, `packages/shared-types/src/events.ts`, `packages/core/src/agent/agent.ts`, `packages/protocol/src/capabilities.ts`, `packages/protocol/src/run.ts`, `packages/runtime/src/rpc/run.ts`, `crates/tui/src/app/handlers/command/prompt.rs`, `crates/tui/src/app/handlers/command/queue.rs`, `crates/tui/src/app/handlers/runtime_response/parsed_output.rs`; tests in `packages/core/tests/agent-steer.test.ts`, `packages/runtime/tests/run-steer.test.ts`, and `crates/tui` command/input/status tests.

This document defines how a user can inject a **steer** message into an already running agent turn at safe execution boundaries, while preserving the existing **queue** (`pending_prompt_queue`) for deferred next-turn execution and falling back to the queue if a steer is not consumed before the run terminates.

---

## 1. Motivation and Relationship to Queueing

[`tui-input-queueing.md`](./tui-input-queueing.md) solves accidental input loss while a run is active by queueing submissions locally in TUI and starting the next `run.start` only after the active run reaches a terminal status.

However, users often want to redirect an active multi-step run **before it finishes** (for example: correcting an assumption, narrowing scope, or providing missing context while tools are running) without aborting and losing the in-flight context via `Esc` / `Ctrl+C`.

- **Queue** = "finish this run first, then start my next prompt as a fresh turn."
- **Steer** = "pick up this user message at the next safe boundary inside the active run and adjust course; if the run ends before picking it up, fall back to the queue."

---

## 2. Goals and Non-Goals

### Goals
1. Deliver user steer messages into an active run at safe agent loop boundaries without corrupting `tool_call` / `tool_result` history pairs.
2. Persist and display applied user steers as real user turns (original message archive, active checkpoint, session history replay, and TUI transcript), distinct from internal `hidden_user_message` injections used by subagent mailboxes.
3. Support full `RunInput` semantics (text, image attachments, and deferred `!` `<shell_result>` blocks) snapshotted at submission time.
4. Fall back cleanly to the TUI local queue (`pending_prompt_queue`) whenever a steer cannot be delivered or is not consumed before the run ends.
5. Keep capability negotiation explicit (`supports_run_steer`) so older runtimes degrade cleanly.

### Non-Goals
1. Preempting or aborting an in-flight LLM HTTP/WebSocket request or an executing tool mid-call (hard interruption remains `Esc` / `Ctrl+C` -> `run.cancel`).
2. Cross-process / cross-restart persistence of unconsumed in-flight steers.
3. Reordering or editing already-applied steers in model history.

---

## 3. TUI UX and Keybinding Design

### 3.1 Commands and Promotion
Regardless of terminal keybinding quirks, two explicit command paths are always available:

- `/steer <text>`:
  - If idle (and gates allow), submits immediately via normal `run.start`.
  - If a run is active and `supports_run_steer` is enabled, snapshots the input (including pending attachments / `<shell_result>`) and sends `run.steer`.
  - If `supports_run_steer` is false, prints an explicit status/error instead of silently queueing unless the user chooses queue.
- `/queue mode [queue|steer|toggle]`:
  - Inspects or switches what plain `Enter` does while a run is active (`queue` default vs `steer`).
- `/queue steer [id|index]`:
  - Promotes the oldest (or targeted) item from `pending_prompt_queue` to an in-flight steer for the active run, removing it from `pending_prompt_queue` and tracking it in `in_flight_steers`.
- `/queue`:
  - Shows the active-run submit mode, in-flight steers awaiting pickup (e.g. `steering: s1 [2s ago] ...`), and `pending_prompt_queue` items.

### 3.2 Composer Keybinding Design (Mode Toggle + Portable Commands)
In `crates/tui/src/event_loop/input.rs`, all modified `Enter` keys (`!mods.is_empty()`, including `Alt+Enter`, `Shift+Enter`, `Ctrl+Enter`) insert a newline (`\n`), matching other major CLI harnesses where `Alt+Enter` stays a newline key across platforms. To keep newline insertion intact across every terminal:

- Keep all existing newline bindings untouched (`Shift+Enter`, `Alt+Enter`, `Ctrl+J`, `\ + Enter`).
- Keep plain `Enter` as the single submit key:
  - When idle: starts a normal `run.start`.
  - When a run is active: submits according to `active_run_submit_mode` (`"queue"` by default, or `"steer"` when `supports_run_steer` is available).
- **`Alt+M`** (or `/queue mode [queue|steer|toggle]`): toggles `active_run_submit_mode` between `queue` and `steer` (using the unused `Alt+M` slot in `input.rs`, with `/queue mode` as the portable fallback on terminals without Meta/Option).
- Status bar (`Info` mode) displays `enter: steer` (or `enter: queue` while running when `supports_run_steer` is enabled) so the active `Enter` behavior is always visible before pressing it.
- `/steer <text>` and `/queue steer [id|index]` provide one-shot steer without changing the mode.

### 3.3 Snapshot Semantics
Steer submission uses the same snapshot rule as [`tui-input-queueing.md`](./tui-input-queueing.md) section 4.5:

- Resolve deferred `<shell_result>` blocks into the payload and clear pending shell results at submission time.
- Materialize image attachment tokens (`[Image N]`) into `RunInput` parts and clear composer input/attachments immediately.
- Retain a local `PendingSteer` record (`client_steer_id`, `run_id`, `submitted_at`, `preview`, `input_payload`, `attachment_count`, `shell_result_count`) until either consumed or returned to the queue.

---

## 4. Core (`@codelia/core`) Contract

`packages/core/src/agent/agent.ts` already defines `AgentRunOptions.pollMessages`, which is polled at two safe boundaries:
1. Before each model step (`prepareInvokeInput` / `invokeModelWithRetry`), after any preceding tool batch has finished and appended all `ToolMessage`s.
2. Immediately before emitting `final` when a model turn returns zero tool calls.

### 4.1 Typed Polled Messages
Extend `pollMessages` (preserving backward compatibility for `string[]` callers such as `subagentMessages`) to support structured entries:

```ts
export type PolledMessage =
  | string
  | {
      kind: "hidden" | "steer";
      content: string | ContentPart[];
      steer_id?: string;
    };
```

- `"hidden"` (or bare `string`): existing behavior — enqueues as user message in model view, records original, and yields `{ type: "hidden_user_message", content }` (no visible TUI chat entry).
- `"steer"`:
  - Records the original user message via `recordOriginals(session, [{ role: "user", content }])`.
  - Enqueues the user message into `this.history` (`enqueueUserMessage(content)` — supporting both `string` and `ContentPart[]`).
  - Yields a canonical event `{ type: "steer_applied", steer_id, content, timestamp }` (or `user_message` event with optional `steer_id`).

### 4.2 Boundary Guarantees
- Steers are **never** polled inside an active tool-call loop between individual tool calls of the same assistant turn, ensuring `assistant.tool_calls` and their `tool` responses always remain paired.
- `forceCompaction` runs do not poll steers; any steer submitted during a compaction run remains unconsumed and falls back to the queue.
- If `Agent` is aborted (`signal.aborted`) before reaching the next poll boundary, queued steers remain unconsumed in the runtime inbox.

---

## 5. Protocol and Runtime (`@codelia/protocol`, `@codelia/shared-types`, `@codelia/runtime`)

### 5.1 Capabilities
Add to `ServerCapabilities` (`packages/protocol/src/capabilities.ts`):
```ts
supports_run_steer?: boolean;
```

### 5.2 `run.steer` RPC
Add `"run.steer"` to `ProtocolMethod` (`packages/protocol/src/methods.ts`):

- Request params (`RunSteerParams`):
  ```ts
  {
    run_id: string;
    input: RunInput;
    client_steer_id?: string;
  }
  ```
- Success result (`RunSteerResult`):
  ```ts
  {
    ok: true;
    steer_id: string;
  }
  ```
- Error responses:
  - `INVALID_PARAMS` for empty/malformed input or invalid `run_id`.
  - `RUN_NOT_FOUND` if `run_id` is not the currently active run (including if the run already finished before `run.steer` arrived).

### 5.3 Runtime Inbox and `pollMessages` Integration
- `RuntimeState` holds a `run_id`-scoped in-memory FIFO inbox of pending steers (`steer_id`, `normalizedInput`).
- On `run.steer`, validate and normalize `input` (including `prepareRunImages` for image refs if present), push into the active run's inbox, and reply `{ ok: true, steer_id }`.
- In `packages/runtime/src/rpc/run.ts`, `pollMessages` drains:
  1. Pending user steers from the active run's inbox (`kind: "steer"`), and
  2. `state.subagentMessages` (`kind: "hidden"`).
- Note on ordering: draining user steers before `subagentMessages` (or in arrival order) ensures explicit user redirection is visible to the model ahead of background peer chatter.

### 5.4 Canonical Event and Persistence
Add a canonical `AgentEvent` in `packages/shared-types/src/events.ts`:
```ts
{
  type: "steer_applied";
  steer_id: string;
  content: string | ContentPart[];
  timestamp?: number;
}
```
- Emitted through `agent.event` notifications and persisted in `SessionStore` (`agent.event`), just like `text` / `tool_call`.
- When `session.history` replays persisted events, `steer_applied` reconstructs the user message line in the TUI log at the exact point in the turn where it took effect.

### 5.5 Unconsumed Steer Reporting and Queue Fallback
When an active run reaches a terminal state (`completed`, `cancelled`, or `error`), the runtime drains any remaining unconsumed steers for that `run_id` and includes their IDs on `run.status` (or `run.end`):

```ts
unconsumed_steer_ids?: string[];
```

#### TUI Fallback Rules
TUI tracks `in_flight_steers: VecDeque<InFlightSteer>` (each holding `client_steer_id`, optional server `steer_id`, `run_id`, and prepared `PendingPromptRun` payload):

1. **Accepted by runtime (`run.steer` OK)**:
   - Record server `steer_id` on the matching `InFlightSteer` and log a compact status line (e.g. `Steer s1 queued for next step`).
2. **Applied by agent (`steer_applied` event)**:
   - Remove the matching entry from `in_flight_steers` and render the user message block in the log.
3. **Rejected before admission (`run.steer` returns `RUN_NOT_FOUND` or transport send fails)**:
   - Immediately convert the unaccepted `InFlightSteer` into a `PendingPromptRun` and push it to `pending_prompt_queue` (if `run.steer` returned `RUN_NOT_FOUND` because the run just ended, push to queue so auto-dispatch picks it up).
   - If the send error outcome is uncertain (same rule as `tui-input-queueing.md` section 6.2 step 5), pause the head item instead of blind replay.
4. **Run ends with unconsumed steers (`run.status` terminal with `unconsumed_steer_ids`, or any remaining `in_flight_steers` scoped to the finished `run_id` without `steer_applied`)**:
   - Move those unconsumed steers in their original submission order into `pending_prompt_queue` **ahead of any items that were queued after them** (preserving chronological intent: steer was meant to act before queued follow-ups), or in strict submission order if tracked via shared sequence IDs.
   - Emit a status line, e.g. `Steer s1 was not picked up before run ended; moved to queue (queue=N)`.
   - Normal queue dispatch gates then start the next `run.start` when ready (or retain them in the queue if the user cancelled and wants to inspect/cancel with `/queue cancel`).

---

## 6. Edge Cases

1. **Pending `ui.confirm.request` / `ui.prompt.request` / `ui.pick.request` (`awaiting_ui`)**:
   - A steer sent while a permission/UI dialog is open stays in the runtime inbox; it is picked up after the dialog resolves and the current tool batch finishes.
   - Input routing must ensure dialogs still own keys while open.
2. **Run cancellation (`Esc` / `Ctrl+C`) while a steer is in flight**:
   - Cancelling the active run causes unconsumed steers to fall back into `pending_prompt_queue`.
   - Consistent with `tui-input-queueing.md` section 4.4, cancelling the active run does **not** clear `pending_prompt_queue`; if the user also wants to drop the fallback steer, `/queue cancel` or `/queue clear` removes it.
3. **Image attachments in steer**:
   - Both methods accept `image_url` input parts. The local runtime converts submitted inline images to stored `image_ref` parts during image preparation.
4. **Subagent runs**:
   - `run.steer` targets only the top-level interactive run (`activeRunId`). Child subagents continue using `task_send_message` / `subagentMessages`.

---

## 7. Open Decisions

1. **Default active-run mode config**: Whether `active_run_submit_mode` starts strictly at `"queue"` per TUI session or can also be configured persistently (e.g. `tui.active_run_submit_mode` in config).
2. **Fallback on cancel (resolved)**: unconsumed accepted steers follow the existing queue dispatch gates and terminal cooldown. An uncertain transport send or non-admission RPC error pauses the item; there is no blind automatic replay of an uncertain send.
3. **Event naming (resolved)**: dedicated `steer_applied` is the canonical event.

## 8. Application acknowledgement and presentation

Polling is not acknowledgement. Runtime retains drained steers until their
`steer_applied` event is emitted. If mailbox polling fails, original recording
fails, or cancellation occurs before application, terminal status returns those
IDs as unconsumed. Core checks cancellation after awaited original recording and
before each history enqueue; enqueue always precedes the applied event.

Live TUI rendering uses the immutable submission display snapshot, including
clipboard-image labels, before removing its in-flight record. The model payload
remains unchanged. History replay uses canonical content with image placeholders
and compact summaries of generated shell-result envelopes, never full deferred
shell output.
