# Desktop product roadmap

Status: Proposed product sequence; M1 HTTP and M4 create/list/open vertical slices implemented; native/provider parity and full lifecycle still open. Checked 2026-10-07. This is a document-based comparison, not a hands-on competitor benchmark. A feature not confirmed in a source is **unverified**, not absent.

The first usable product exit is: **two isolated tasks → interrupt → restart → safe recovery → review/test/integrate → archive/restore, without lost changes or duplicated side effects**. Local-first, provider-neutral operation is a positioning hypothesis to validate, not an established moat. Worktree management belongs in the standard task lifecycle.

## Reference baseline

| Official source | Documented baseline relevant to this roadmap |
| --- | --- |
| [Claude desktop](https://code.claude.com/docs/en/desktop) | Parallel sessions with Git isolation, session operation, permission decisions and diff review. |
| [Zed parallel agents](https://zed.dev/docs/ai/parallel-agents), [agent panel](https://zed.dev/docs/ai/agent-panel) | Thread/project navigation, worktree create/select/setup hooks, and archived-thread/worktree restoration. |
| [Cursor Agents Window](https://cursor.com/docs/agent/agents-window) | Dedicated agent window reference. Detailed lifecycle/worktree behavior was not recoverable from this page's rendered text in this pass; retain it as unverified. |
| [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [app server](https://learn.chatgpt.com/docs/app-server) | Managed worktree retention/snapshot/restore and typed thread/turn/item delta, completion and interruption events. |

## Current Codelia evidence

| Area | Implemented | Missing / unverified |
| --- | --- | --- |
| Runtime task substrate | [LaneManager](../../../packages/runtime/src/lanes/manager.ts) creates/lists/inspects/closes Git worktrees with task/branch/session records. It rejects dirty removal and live tmux lane close without explicit force. [Lane tools](../../../packages/runtime/src/tools/lane.ts) expose the operator surface; [tests](../../../packages/runtime/tests/lane-manager.test.ts) cover its policy. | Worktree lifecycle is coupled to tmux (zellij currently rejects). Generic task worktree leases, arbitrary owned process protection, archive/restore and integration transactions are not implemented. A separate common Git primitive now supports the desktop service without mux/agent launch; temporary Mac Git/RPC smoke validates that subset. |
| Children | [Coordinator](../../../packages/runtime/src/subagents/coordinator.ts) reuses existing depth-one child execution, messaging and cancellation; its schema accepts only `live_workspace`. [Task spec](../task-orchestration.md) marks worktree mode/leases planned. | Isolated worktree children and restart-safe workspace leases are not implemented. No second orchestrator should be introduced. |
| Desktop | [Application commands](../../../crates/desktop/src/application.rs) are shared by UI and run-scoped `codelia_app`; sessions, approvals, Stop, child status/cancel and optional Changes are present. | Explicit worktree create/list/status/open is implemented through the common runtime service; [contract](worktrees.md). Archive/restore/cleanup/integration and leased children remain absent. Final native approval/Stop/child/input flows are unverified; see [validation](../../../crates/desktop/VALIDATION.md). |
| Current drafts | [Native local draft store](drafts.md) restores acknowledged nonempty text by physical project/checkout/thread; coalesced background save, exact staged Send/Clear, cancelled-action isolation, corrupt/stale-writer failure and temporary-state restart/abrupt-exit tests pass. | Unacknowledged edits may be lost on forced termination; no automatic submitted-prompt replay. Native OS restart/IME and concurrency/resource measurements remain open. |
| Live text | [Shared stream contract](../model-text-stream.md), optional model sink, Agent retry/discard and desktop projection are connected through the existing runtime; real loopback early-delivery/history tests pass. | M1 product acceptance still needs native GUI behavior and provider-wide transport parity; completion of this HTTP slice does not close the product milestone. |

## Milestones and acceptance

| Milestone | Deliverable | Acceptance |
| --- | --- | --- |
| M1: live text and stable events | Provider-neutral, opt-in run/invocation/attempt/item identity with partial/commit/discard. Bounded producer flow; canonical completion remains history authority. | Real loopback text arrives before completion; retry retracts only the failed attempt; cancel/consumer return releases the producer; late/duplicate events cannot corrupt another run; replay contains only canonical text. Multiple adapters run the same contract tests as they gain support. |
| M2: lifecycle recovery | Explicit Stop/reconnect/restart/retry states and durable action outcome/admission identity. | Interrupt and restart both isolated tasks without resubmitting unknown writes or tools; display unknown outcomes and require reconciliation before retry. Parent Stop and child cancellation remain distinct. |
| M3: scoped approval | Typed actor, target workspace/task, exact operation and once/session/rule scope through runtime authority. | Two concurrent approvals cannot swap targets; stale/cancelled dialogs cannot execute; scope is visible and persisted rules are tested; UI and internal agent cannot bypass approval. |
| M4: standard worktrees | Create/list/attach/base/setup/preserve/archive/restore/cleanup through a shared workspace service. | Each task has its own branch/checkout/status; dirty and active-use trees are preserved; failed setup rolls back only owned clean artifacts; archive/restore preserves tracked and relevant untracked changes. Never equate thread archival with safe deletion. |
| M5: review/test/integrate | Diff plus validation tied to source revision and explicit integration destination. | A reviewed/tested revision integrates into the selected destination only if both revisions still match; conflicts and dirty destinations fail safely; the reviewed result can be traced to its checks. No hidden commit/merge/push. |
| M6: usable compact shell | Keyboard/focus/IME, optional panels, clear child/approval status, long transcript and concurrent task measurements. | Repeat the complete product exit via UI and typed commands. Measure 1/4/8 tasks: first-text latency, stop/recovery latency, memory, transcript/scroll responsiveness, with device/build/workload specified; set budgets from actual measurements. |

## Shared service and command boundary

The initial create/list Git mechanics are extracted; extend shared worktree mechanics from lane/multiplexer orchestration into runtime infrastructure; retain one task coordinator. Persist repository/workspace/task/branch/base/revision identities and explicit ownership/reference leases. Attach existing trees read-only before deciding ownership; do not delete an attached user tree as an owned temporary artifact. Setup has explicit state and bounded logs, with runtime approval for side effects.

Expose one typed application command contract to native UI and internal agent clients. Commands carry operation identity, actor, target, expected revision and scoped approval; results carry phase/outcome, failure reason and reconciliation hints. Implemented RPCs are worktree.list/create; native application commands additionally validate explicit opening of a listed checkout. Archive/restore/cleanup and review/test/integrate remain proposed command families. Cleanup checks all owning runs/children/processes and unsaved changes before mutation; explicit force is a separate reviewed action, never a retry fallback. Integration additionally identifies destination revision. UI renders branch, change size, runtime/task state and pending decision from the same projections.

Cloud execution, scheduling, PR/CI automation and a full file editor are deferred until this local task lifecycle is dependable. The implemented worktree subset authorizes no deletion, pruning, merge/integration or archive/restore. M4 acceptance remains open until ownership/recovery/destructive guards are implemented and verified.


## Checkpoint and remaining work, 2026-10-07

M1/M2/M3/M4/M6 remain partial. Implemented evidence includes real HTTP SSE early text, explicit fresh threads, guarded checkout/session/model identity, unknown worktree restart observations without replay, exact once-only creation approval, and current acknowledged composer draft recovery. The user-reported Recovery QA missing-workspace bounds crash is reproduced and fixed with an actionable empty window; the new normal development bundle has no fixture dependency. Native headless/temporary-state tests and builds are evidence for those subsets; they do not close the complete UI product exit.

Next acceptance work:

1. Native connected OS QA for approvals, parent Stop/child lifetime, repeated send/cancel, thread/worktree switch, draft save/Clear/quit/reopen, Japanese IME and narrow panels, using a new identity-verified bundle and a synthetic loopback provider.
2. Durable admission/outcome reconciliation for actual tool side effects and restart-owned children/processes, with no blind replay. Current draft consumption cannot infer whether an interrupted runtime request executed.
3. Generic worktree leases and explicit attached/owned/dirty/live-use rules, then archive/restore/cleanup tested in disposable repos. Current create/list/open authorizes no destructive lifecycle.
4. Revision-bound review/test/integrate with an explicit destination, conflicts/dirty guard and traceable validation. M5 is planned.
5. Provider stream parity and reproducible 1/4/8 task latency, memory and input/scroll measurements before declaring performance or release readiness.

Cloud scheduling, PR/CI automation and full editing remain deferred. No commit/merge/push/publication, worktree deletion or paid model validation was added in this checkpoint.

Latest UX recovery checkpoint: composer provider/model selection remains available under unsupported configured provider; explicit static catalogs and per-thread run model choice preserve global config/auth. Child shell jobs are excluded; duplicate folder identities/current worktree labels and collapsed diagnostics are implemented. Headless/runtime regressions pass; native connected model switching/auth setup/pixels and performance gates remain open.
