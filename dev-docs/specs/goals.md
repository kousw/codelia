# Goals Spec

Status: `Implemented` for the local TUI and SQLite-backed runtime. Both ends
opt in with `supports_goals`.

## 1. User contract

A goal is a user-authored objective that stays with one session across turns.
The local TUI can continue working on it after a successful turn. Each
continuation is a normal run with the existing model, tools and approval policy.

| TUI action | Behavior |
| --- | --- |
| `/goal <objective>` | Create and activate a goal, or edit the current objective. An edit preserves usage and the current stop state. A completed goal requires clearing it before creating another. |
| `/goal` | Display the objective, status, reason for stopping, measured usage and optional budget. |
| `/goal budget <tokens\|off>` | Set or remove the optional token budget. Changing the budget preserves measured usage and requires explicit resume if stopped. |
| `/goal pause` | Disable subsequent automatic starts. An admitted run may finish. |
| `/goal resume` | Activate a stopped goal after checking session ownership, storage and the budget. |
| `/goal clear` | Remove the current goal while idle. Conversation history is retained. |
| `Esc` during goal execution or admission | Disarm continuation and cancel the matching admitted run, if one exists. |

Registering a goal in a fresh TUI creates an empty session checkpoint without
a run ID. Runtime allocates the session ID and binds the session, with the same
workspace and draft-attachment ownership as a fresh run. A failed write leaves
the previous binding intact. Commands never create a goal from ordinary chat
input. Editing, changing budget, resuming and clearing require an idle runtime
and no in-flight reservation for the goal.

Append `goal <status> · <objective preview>` to the existing run row above the
composer while a goal exists. Keep the run status first. Normalize whitespace,
strip control characters and fit the objective preview on one line using
terminal display width. Narrow terminals can omit the preview. Show
`goal resume required` when a saved active goal requires explicit resume.
`/goal` shows the full objective, stop reason, usage and budget on demand.
The goal segment needs no extra row or elapsed timer.

### Status and limits

| Status | Meaning |
| --- | --- |
| `active` | Eligible for a new goal run once the current connection and runtime satisfy the start conditions. |
| `paused` | Stopped by the user, by an execution/verification failure, by an unresolved prior launch, or by the automatic turn limit. Store a typed reason. |
| `blocked` | The same identified obstacle has prevented meaningful progress in at least three consecutive goal runs. |
| `usage_limited` | Required usage is unknown for a budgeted goal. |
| `budget_limited` | Measured usage has reached the configured budget. Set a sufficient budget or turn it off before resuming. |
| `complete` | The agent reported evidence that the goal requirements are met, and runtime finalized that run successfully. |

On explicit activation or resume, offer at most three automatic run admissions
in that activation. A turn started through ordinary user input does not reset
the allowance. A failed or uncertain admitted auto run consumes its slot.
Runtime pauses at the limit and displays the reason. An unresolved request for
user input holds the active run. Cancellation, unrecovered errors and shutdown
leave no eligibility for automatic continuation.

On session reopen, show the saved goal and require explicit resume for further
automatic execution. A reopened session with a stored `active` record but no
ownership on this connection is displayed as requiring resume. Reading that
record does not mutate another runtime's state.

## 2. State and protocol

Use the existing local `state.db` through `packages/storage`. Store one current
goal per session in a separate table from the conversation checkpoint so
ordinary checkpoint writes cannot overwrite goal changes.

- Goal record: `session_id`, `goal_id`, `revision`, objective, status, optional
  stop reason, optional token budget, measured tokens, accounting completeness,
  activation ID and its accepted automatic run count, and timestamps.
- Keep a durable reservation for an admitted goal run until finalization.
  Include `run_id`, goal identity and revision, activation ID, the runtime
  process owner, and the continuation ID if the run came from a ready event.
- Goal edits or state changes advance the revision. Usage updates alone do not.
  A new activation gets a new activation ID and allowance. A new logical goal
  gets a new goal ID.
- Compare-and-set writes check goal identity and revision. A unique constraint
  or equivalent atomic conditional write consumes each continuation ID once,
  together with reservation and allowance accounting. Store the accepted run
  ID so readback can reconcile a lost acknowledgement.
- Use a short SQLite transaction for the reservation and state update. A
  process-local admission lock coordinates Runtime handlers. The durable
  reservation serializes goal starts across local runtimes sharing the store.
  Explicit resume can transfer idle ownership. A live or unverifiable
  reservation prevents takeover. For an orphan with a verifiably dead owner,
  explicit resume reconciles it as interrupted before arming a fresh start.
  Reuse existing process identity primitives where available. A timeout by
  itself is insufficient evidence that an owner is gone.

Runtime advertises `supports_goals` for the local TUI path with a
`SessionStateStoreImpl`; the client opts in with the same capability.
Goal management uses the bound session. Opening a delegated session as a root
session is rejected by the existing session binding path.

| Message | Contract |
| --- | --- |
| `goal.get` | Fetch the goal snapshot and whether it can continue on this connection. When reconciling a specific continuation ID, return the matching accepted run ID if recorded and the active run ID when that run is still active. |
| `goal.set` | Create or edit the objective and budget. Supply the expected goal ID and revision when updating. |
| `goal.pause` | Disable continuation for the matching session, goal and activation. An interrupt targets a known run ID or the continuation ID whose start acknowledgement is pending. |
| `goal.resume` | Explicitly request a new activation for the matching goal. |
| `goal.clear` | Release the goal while idle. Require the expected goal ID and revision. |
| `goal.updated` / `goal.cleared` | Notify the client of the session-scoped state change. Ignore notifications for previous session bindings. |
| `goal.ready` | Offer one continuation after activation or a fully finalized goal run. Fields include session ID, goal ID, revision, continuation ID and predecessor run ID if available. |
| `goal.continue` | Echo the current offer and provide the same per-run UI context and tool declarations as an ordinary TUI run. Runtime derives the goal input from stored state. The result identifies the accepted run or a typed reason for declining. |

The offer is scoped to one connection, activation and completed boundary. A
later user run, a session switch, a stop or a goal edit invalidates it. The
client sends a given offer once. If the acknowledgement is missing or sending
has an unknown outcome, enter a checking state and reconcile via `goal.get`
and run identity. TUI never sends a second automatic start to recover an
ambiguous response. Resume remains explicit after unresolved state.

## 3. Continuation and stop ordering

The TUI owns its undispatched queue. Runtime owns run admission and the durable
goal. A continuation uses this order:

1. Fully finalize the previous run. Terminal `run.status` remains the existing
   display and Steer-fallback signal. It can arrive before Runtime is idle.
2. Expose successful checkpoint completion to the goal path. The current
   `queueSessionSave` catches and logs errors, so awaiting it alone is
   insufficient. Publish `goal.ready` after `finishRun`, successful
   checkpointing and successful goal accounting. Pause with a reason on
   failure. An initial activation on a settled session can offer a start
   without a predecessor run.
3. Process terminal status and Steer fallback in TUI first. Give pending user
   work precedence. Explicitly verify an empty prompt queue, including paused
   or backoff entries, and no dispatching prompt, file upload, pending
   run/cancel/Steer RPC, or runtime dialog. The return value of
   `try_dispatch_queued_prompt` signals an action and cannot prove the queue is
   empty. User inputs processed before automatic admission get priority.
   Inputs arriving after admission follow existing Queue/Steer behavior.
4. Route the request through the same serialized admission path as
   `run.start`. Take `withAdmissionLock` once. Recheck the offer, session,
   active run, goal authority, stop intent, budget and allowance. Recheck
   after asynchronous setup before reserving and starting work. Invalidate old
   offers when admitting another user run. Hold the lock for admission only.
5. Reserve a run ID and consume the offer atomically in storage before model
   or tool execution. Start the normal run with that ID. The reservation is
   finalized on every outcome. A startup crash leaves an ambiguous
   reservation to reconcile on explicit resume.

Do not hold the admission lock while awaiting an RPC handler that acquires the
same lock. Share internal admission logic between manual and automatic entry
points. Preserve the current runtime approval checks and client tool transport.

For an interrupting pause, latch the matching stop intent in Runtime before any
await that could allow continuation. Revoke the offer and reject stale requests
even if the previous run already ended. Persist the pause and abort only the
matching admitted run when cancellation was requested. An unresolved start is
matched by its continuation ID. A delayed stop for an old session or goal
must not abort a newer run. On persistence failure, keep
the current connection disarmed, report the failure and require explicit
recovery. When a new session is bound or the connection is lost, revoke local
arming. A decision to resume rechecks pending ownership and budget.

Code anchors for the existing routes:

- `packages/runtime/src/rpc/run.ts` emits terminal status, saves the
  checkpoint and calls `finishRun`. It also owns the existing admission queue
  shared with `session.open`.
- `packages/runtime/src/runtime-state.ts` owns `withAdmissionLock` and the
  current run lifecycle.
- `crates/tui/src/app/handlers/runtime_response/apply.rs` and
  `crates/tui/src/app/handlers/runtime_response/steer.rs` requeue unconsumed Steers on
  terminal status.
- `crates/tui/src/app/handlers/command/prompt.rs` dispatches the user queue
  and already handles the case of an uncertain send.

## 4. Goal context and accounting

Associate a run with its goal ID and revision at admission. A resumed goal uses
the latest worktree and session checkpoint as its starting point. Introduce the
objective as user-authorized context below system and developer instructions.
Mark automatic continuation as Runtime-originated in run history. Preserve the
user's original messages without adding a synthetic chat message from them.
Reuse the existing tool policy, replay and compaction paths.

Automatic shell review on a continuation receives the saved objective followed
by the same goal's applied user Steers in order. Only canonical `steer_applied`
events contribute. Save this bounded evidence with the run claim's finalization
and preserve it across explicit pause and resume. An older goal without recorded
evidence, an unreconciled run, or an incomplete correction history defers
automatic review. Clearing the goal ends its approval context.

Editing the objective places previously applied Steers before the new objective
in approval evidence. Later Steers follow it. The newest relevant user instruction
takes priority in a conflict, and earlier restrictions still apply when compatible.

### Model-facing tools

Eligible manual runs and automatic continuations receive the objective as a
transient user-level message after prior conversation and before current input
and steers. Newer user instructions take priority. The objective stays in the
model request across tool steps and in the tool-free max-iterations summary.
It is omitted from original conversation records and checkpoints.
[`GoalController.tools`](../../packages/runtime/src/rpc/goals.ts) describes
when and how to report verified completion or a blocker before the final answer.

- `get_goal({})` returns the objective, status, recorded tokens, and budget in
  `goal`. It returns `{goal: null}` if the run no longer holds the reservation.
- `update_goal({status: "complete", evidence})` reports that every requirement
  has been verified. State the check and observed result in `evidence`.
- `update_goal({status: "blocked", evidence, blocker_key})` reports an obstacle
  that prevents further work. Explain the obstacle and reuse the same
  `blocker_key` whenever the underlying obstacle is the same.
- Ordinary progress needs no report. The latest accepted report in the run
  replaces any earlier report. The runtime evaluates it after successful
  finalization while the same goal and revision still own the run. Three
  consecutive goal runs reporting the same blocker key stop the goal.

Goal creation and control stay with explicit user actions. Child sessions
handle delegated objectives through existing task messaging.

### Token accounting

Count normalized, provider-reported non-cached input plus output for the
parent's ordinary model steps and its end-of-run summary call. Count a
delivered response once per
`(run_id, invocation sequence)`, independently of whether diagnostics are
enabled. Use the Core accounting boundary or a dedicated awaited observer.
Run diagnostics also provide a useful fixture source. For a budgeted goal,
durably mark a model call as in flight before dispatch. Resolve that marker
with the measured usage, a verified non-billable failure or unknown usage.
An interrupted call or an uncertain retry can leave usage unresolved. Preserve
known usage through stop, crash and retry. Charge the admitted goal's run even
if the user paused that goal while it was running. Use the goal ID for that
accounting and the revision for authorizing status changes. Avoid deriving a
delta from agent session lifetime totals or interpreting an unknown count as
zero.

The first budget is a threshold for subsequent automatic turns rather than
a strict provider spending cap. An already admitted response can exceed the
threshold. At finalization, an unfinished over-budget goal enters `budget_limited`.
A budgeted goal with unresolved usage stays `usage_limited` until reconciled
or the user removes the budget. Dedicated compaction calls, subagents and
independent model calls inside tools are outside this initial counter. Expose
that coverage in the usage display.

## 5. Acceptance

Storage lives in `packages/storage/src/session-goals.ts`. The runtime handler
in `packages/runtime/src/rpc/goals.ts` owns goal transitions and uses the
shared admission path in `run.ts`. The TUI command and scheduling logic live
in `crates/tui/src/app/goal.rs`.

| Scenario | Expected outcome |
| --- | --- |
| Successful run finishes with an active goal | One successful checkpoint and finalize produce one eligible offer. |
| Paused queue head, pending upload, or unresolved Steer | User work remains ahead of automatic continuation. |
| Duplicate offers or two local TUI processes | Only one reservation for that goal boundary can start a run. |
| `Esc`, switch session, or edit while admission is pending | A stale continuation is rejected and the newer session or goal is untouched. |
| Terminal checkpoint save fails | The goal pauses and emits no ready offer. |
| Crash after reservation or lost launch response | The client reconciles the existing run identity and never automatically replays uncertain work. |
| Pause, finalization and completion report race | The matching stop is retained. A stale or unsuccessful run cannot publish a completion. |
| Token use crosses the threshold or usage is unknown | Known usage persists. Further budgeted continuation is withheld. |
| Last automatic slot consumed or provider error remains after retries | The goal shows a stopped reason. Resume requires a user action. |
| Session reopened after crash or clean shutdown | The goal remains visible. Running again requires explicit resume. |

Run storage and admission tests with competing connections and injected failures.
Verify TUI queue priority, `Esc` and restart using the local runtime with a
deterministic model fixture before any live-provider validation.

Later work can add Desktop support, unattended continuation without an attached
TUI, model-callable explicit goal creation and joint budget enforcement across
the parent and its tasks. Existing task and lane lifecycles remain the basis
for delegated work.
