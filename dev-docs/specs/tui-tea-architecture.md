# TUI TEA Architecture & Migration Spec

Status: `Proposed` (2026-11-27, revised after Opus design review)

This document defines the target architecture for refactoring `crates/tui` toward a pragmatic **TEA (The Elm Architecture)** in phased, mostly behavior-preserving commits (with one intentional paste-consistency fix noted in §4.2).
It builds on [`tui-architecture.md`](./tui-architecture.md), [`tui-render-state-machine.md`](./tui-render-state-machine.md), [`tui-owned-text-selection.md`](./tui-owned-text-selection.md), [`tui-image-preview.md`](./tui-image-preview.md), and [`ui-protocol.md`](./ui-protocol.md).

---

## 1. Context and Goals

`crates/tui` (~40.1k lines: ~24.5k production, ~15.5k test) already maintains clean coarse boundaries (`view` does not import `handlers`; `state` does not import `view`/`handlers`/`render`; wire decoding goes through `codelia-protocol`). However, organic feature growth has concentrated complexity in five places:

1. **Modal/panel priority duplication**: 14 independent `Option<...>` fields on `AppState` (`confirm_dialog`, `pending_confirm_dialog`, `prompt_dialog`, `pick_dialog`, 6 list panels, 3 model/provider/reasoning pickers, `queue_steer_picker`), with priority and paste blocking hand-coded separately in `view/ui/panels/mod.rs`, `event_loop/input.rs`, `entry/run_loop.rs`, and `app_state/methods.rs` (including a display-vs-key ordering mismatch between `context_panel` and `skills`/`theme`). `PickDialogState` also multiplexes four distinct roles via flags (`approval`, `shell_rule_picker`, `local_update_picker`, generic/client-tool pick).
2. **Manual `RpcPendingState`**: ~35 individual `Option<String>` request-id fields plus a ~100-line `if` chain in `take_match_for_response()`, with per-request metadata stored in separate side fields.
3. **`ParsedOutput` 34-field property bag**: `runtime/parser` packs every decoded notification/request into one flat 34-field struct that `handlers/runtime_response/parsed_output.rs` (819 production lines + 1,793 test lines) re-dispatches procedurally.
4. **Coupled I/O in handlers & test harness friction**: Handlers write directly to `BufWriter<ChildStdin>`, call `TuiTerminal` APIs, or spawn local subprocesses/threads. Six test files (`#[cfg(unix)]`) must spawn `Command::new("cat")` to capture RPC writes (`upload.rs` has Unix-only tests; `shell_rules` is tested indirectly via `event_loop/input.rs`; `self_update.rs` and `entry/run_loop.rs` have no unit tests).
5. **Five small cyclic/reverse dependencies**:
   - `app_state/mod.rs` ⇄ `handlers/command/upload.rs`
   - `event_loop/input.rs` ⇄ `entry/terminal.rs`
   - `runtime/client.rs`, `app/self_update.rs`, `app/startup_confirmations.rs` ⇄ `entry/launch_context.rs`
   - `app/util/*` ⇄ `app/state/*` & `app/image_preview/*` (`util/clipboard/mod.rs`, `util/attachments/staging.rs`, `util/attachments/mod.rs`, `util/user_message.rs`, `state/log/mod.rs`)
   - `app/render/frame.rs` → `app/view::draw_ui`

### Goals

- Converge `crates/tui` onto a pragmatic, zero-extra-dependency TEA structure:
  - **Synchronous mockable RPC transport (`&mut dyn RuntimeTx`)** passed into state transitions so handler-specific send-failure rollbacks remain exact while eliminating `Command::new("cat")` test workarounds.
  - **`Model` + `Msg` + `update(app, msg, tx) -> UpdateResult { effects, needs_redraw, exit }` + `view(frame, app)`**, restricting `Effect` to terminal, clipboard, and local background worker side effects.
- Enforce overlay priority, RPC slot semantics, and runtime-message typing in Rust's type system.
- Eliminate the five measured reverse/cyclic dependencies and guard them with an import-hygiene test.

### Non-Goals

- **No external TEA/TUI framework crates** (e.g., `tui-realm`). Ratatui 0.30 + standard Rust enums/traits stay the only UI foundation.
- **No change to Inline vs Alternate terminal buffer policy**. Inline native scrollback (`Terminal::insert_before`), `committed` source anchoring, bounded 2-pass `draw_frame`, and headless xterm CI verification remain unchanged.
- **No directory relocation of `app/` feature-sliced modules** (`goal.rs`, `image_preview/`, `self_update.rs`, `startup_confirmations.rs`) in this track; their placement will be decided separately after the TEA boundary stabilizes.
- **No wire protocol changes** (`codelia-protocol` and `@codelia/runtime` remain unchanged).
- **No wholesale `AppState` field-churn commit**: grouping `AppState` fields into sub-structs is optional and limited to cohesive lifecycle groups (`Transcript`, `Components`) where `clear_log` / reset invariants benefit directly.

---

## 2. Preserved Critical Invariants

Every phase MUST preserve the following invariants:

1. **Inline scrollback & render bounds**: `inserted_until <= visible_start <= visible_end <= wrapped_total`, logical `committed` (log index + grapheme offset) re-projection on width change, Ratatui `scrolling-regions` disabled, wide-glyph continuation cell blanking in disposable insert buffers, and `draw_frame` bounded to at most 1 `insert_before` + 2 `draw` calls.
2. **Live streaming fence**: `stream_commit_boundary()` allows stable lines/paragraphs into native scrollback while fencing only the mutable Markdown tail; canonical events hand off without duplicate rows.
3. **Two-stage Confirm lifecycle (`Pending -> Active`)**: Incoming `ui.confirm.request` enters `ConfirmSlot::Pending` until one rendered frame completes, then promotes to `ConfirmSlot::Active` and immediately `continue`s the tick loop before polling keys (prevents accidental Enter approval).
4. **Concurrent runtime UI requests**: Because `packages/runtime/src/rpc/ui-requests.ts` serializes only `confirm` and `pick` (not `prompt`, and not client-tool `tui_ask_user_choice`), `confirm`, `prompt`, and `pick` MUST remain independent slots (`RuntimeDialogs`) so an incoming request of one kind never overwrites another live request.
5. **Update picker drawn-cell safety**: `/update` and startup update pickers accept `Enter` only when the selected ASCII option label was actually drawn in the current terminal size (`drawn_update_choice` + unchanged `terminal.size()`), and **only when no `RuntimeDialog` (confirm, prompt, or pick) is open**.
6. **Owned text selection (Alternate mode)**: `SelectionProjectionId` depends only on `(log_version, wrap_width)`, never `frame_revision`; only unmodified primary drag is owned.
7. **Single-slot `ImageArtifact` RPC & revision gating**: Only one `/image-artifact` RPC may be in flight at a time (`command/image.rs` rejects a second request while one is pending); `clear_log()` explicitly clears the pending `ImageArtifact` slot (`tui-image-preview.md:31`). A delayed reply whose `preview_revision` is older than the current preview state is drained and ignored without undoing newer opens/closes.
8. **Queue & Steer safety**: Uncertain `run.start` or inconsistent `steer_applied` IDs pause automatic dispatch without silent replay; `busy` retries at most 5 times with 200 ms backoff.

---

## 3. Target Pragmatic TEA Architecture

### 3.1 Core Loop & `RuntimeTx` Boundary

```rust
/// Minimal object-safe runtime RPC writer + ID allocator.
/// Production wraps `(&mut BufWriter<ChildStdin>, &mut u64)`;
/// unit tests use an in-memory `MockRuntimeTx` (with optional write-error injection).
pub(crate) trait RuntimeTx {
    fn next_id(&mut self) -> String;
    fn send_line(&mut self, line: &str) -> std::io::Result<()>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitAction {
    None,
    /// Render the final frame (e.g., "runtime exited: ...") before breaking out of the loop.
    DrawThenExit,
    /// Break immediately without drawing (e.g., double Ctrl+C force quit).
    ExitNow,
}

pub(crate) struct UpdateResult {
    pub(crate) effects: Vec<Effect>,
    pub(crate) needs_redraw: bool,
    pub(crate) exit: ExitAction,
}

pub(crate) fn update(app: &mut AppState, msg: Msg, tx: &mut dyn RuntimeTx) -> UpdateResult { ... }
```

**Why RPC sending stays synchronous via `&mut dyn RuntimeTx` (not `Effect::SendRpc`)**:
- Today's send-failure rollback is handler-specific and uses context not present in `PendingRpc` (e.g., `goal.continue` intentionally leaves `run_start_id` set and resets `check_at = now`; `upload` registers pending state only after send succeeds and calls `pause(seq)` on failure; `steer` / `queued dispatch` re-enqueue at max attempts; `image` clears all 3 image slots; `try_dispatch_queued_prompt` branches synchronously on `sent`).
- Passing `tx: &mut dyn RuntimeTx` directly into `update()` preserves 100% of those rollback paths with zero extra indirection while making every handler cleanly unit-testable with `MockRuntimeTx`.
- `Effect` is therefore scoped cleanly to **non-RPC shell side effects** (terminal control, clipboard writes, and local background worker launches).

### 3.2 Tick Execution Order & Two-Phase Tick Messages

To preserve exact `entry/run_loop.rs` semantics—including the `continue` branches on `KeyEventKind != Press`, `image_preview` key handling, `Ctrl+C`, and blocked paste that intentionally skip post-input ticks—the loop separates pre-draw and post-input ticks:

1. **Per-line runtime drain (up to `MAX_RUNTIME_LINES_PER_TICK = 300`)**:
   - Because `parse_runtime_output_with_history()` depends on live `session_history_id.is_some()` and `active_run_id` **per line** (`runtime_response/mod.rs:61-69`), the shell MUST NOT batch-parse all queued lines before updating `AppState`.
   - Contract: either pass `Msg::RuntimeLine(String)` into `update()`, or parse **one line** using current `AppState` and immediately call `update(app, Msg::Runtime(msg), tx)` before reading the next line.
2. **Local worker polls**:
   - Preempt `image_preview` if `app.overlays.has_active_overlay()`.
   - Poll `image_preview`, `self_update`, `startup_confirmations`, `clipboard_import` → feed completed `Msg::Local(...)` into `update()`.
3. **`Msg::PreDrawTick`**:
   - Skills catalog auto-fetch (`maybe_request_skills_catalog`), initial message auto-start, queued prompt dispatch (`!startup_pending`), and `child.try_wait()` exit check (`ExitAction::DrawThenExit`).
4. **Render frame (if `needs_redraw`)**:
   - Capture `size_before` if `UpdatePicker` is active and `!app.overlays.runtime_dialogs.is_any_open()`.
   - Run bounded `draw_frame()` inside synchronized update.
   - If `app.overlays.runtime_dialogs.activate_pending_confirm()` promotes `Pending -> Active`, set `needs_redraw = true` and `continue` (before polling input).
   - If `exit == ExitAction::DrawThenExit`, break.
5. **Terminal event poll (`50 ms`)**:
   - Handle `Event::Key` (with 2-second double-`Ctrl+C` → `ExitAction::ExitNow`), `Event::Paste`, `Event::Mouse`, `Event::Resize` → `Msg::Terminal(...)` → `update()` → execute `Effect`s.
6. **`Msg::PostInputTick { now, child_pid }`**:
   - Runs only when step 5 did not early-`continue`: `goal::tick`, spinner advance, selection-notice expiry, and 1-second RSS memory sampling (`--debug-perf`).

### 3.3 Honest Contract for `draw_ui(frame, &mut AppState)`

`draw_ui` stays `pub fn draw_ui(f: &mut Frame<'_>, app: &mut AppState)` rather than splitting `(&AppState, &mut RenderCache)` (which conflicts with Rust's borrow checker because `flush_stream_output()` mutates `log` and scroll clamping mutates `scroll_from_bottom`).

Instead, we enforce a clear explicit rule on what `draw_ui` may mutate:
- Allowed mutations during `draw_ui`:
  - `render_state` and wrap/hit-map cache fields (`wrapped_log_cache`, `last_wrapped_total`, `last_wrap_width`, `last_log_viewport_height`, `transcript_hit_map`, `transcript_frame_revision`)
  - `flush_stream_output()` (flushing pending live stream deltas into `log` before wrapping)
  - viewport scroll stabilization / clamping (`scroll_from_bottom`) and acknowledging `log_changed`
  - invalidating `text_selection` when `selection_input_blocked()` or layout invalidates projection
  - recording `image_preview.desired_size`
- `scroll_from_bottom = 0` while `confirm` / `prompt` is open: either block mouse-wheel scroll in `update()` when `confirm` or `prompt` is open (documented equivalent behavior) or keep the reset explicitly in `draw_ui`'s allowed viewport adjustment list.

---

## 4. Core Interface Designs

### 4.1 `PendingRpcs` (Replacing 35 `Option<String>` Fields)

#### Concurrency & Precedence Rules

1. **Singleton slots (`PendingRpcSlot`) — Last-Write-Wins**:
   - Every outgoing RPC except `RunSteer` occupies a named `PendingRpcSlot` (including `ImageArtifact`, which is single-slot: `command/image.rs` checks `has_slot(PendingRpcSlot::ImageArtifact)` and rejects concurrent requests).
   - `PendingRpcs::insert_singleton(id, rpc)` **evicts any prior request ID occupying the same `PendingRpcSlot`** (returning the evicted `(old_id, old_rpc)` if any), matching today's field-overwrite behavior so stale responses fall through as unmatched and are ignored.
   - `PendingRpcs::remove_slot(slot)` removes the active entry for a slot (used by `clear_log()` for `ImageArtifact` and by `image.rs` error cleanup across all 3 image slots).
2. **Multi-in-flight (`RunSteer`)**:
   - `PendingRpcs::insert_multi(id, PendingRpc::RunSteer { client_steer_id })` allows multiple concurrent in-flight steer RPCs keyed by `request_id`.
3. **Separate trackers & response routing precedence**:
   - Keep `goal` request tracking (`goal.rs:113-124`, plus `goal.continue` which shares `run_start_id`) and server-initiated `client_tool_choice_ids: HashSet<String>` outside `PendingRpcs::by_id`.
   - Exact response routing order in `handlers/runtime_response/mod.rs` MUST stay:
     1. `goal::handle_response` (continuation `run_start_id` + `goal.requests`)
     2. `upload::handle_response` (or matched via `PendingRpc::Upload` before generic table if moved into `PendingRpcs`)
     3. `app.rpc_pending.take(&response.id)` (`O(1)` `HashMap::remove`)
     4. Unmatched fallback (`runtime_response/mod.rs:406-416`)
4. **Explicit auto-start blocker table**:
   - `PendingRpcSlot::blocks_auto_start(self) -> bool` is an explicit exhaustive `match` (locked by unit test), intentionally returning `false` for `Initialize`, `RunStart`, `RunCancel`, and `Upload` (and `RunSteer` has no slot / is excluded), matching `has_auto_start_blockers()` (`app_state/mod.rs:352-380`).
   - `PendingRpcs::has_shell_rule_run(&self) -> bool` explicitly checks for `PendingRpc::ShellRules(ShellRuleRpc::Run { .. })` (preserving `can_dispatch_prompt_now()`).

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingRpc {
    Initialize,
    AutoReview,
    ShellRules(ShellRuleRpc),
    ImageModelGet,
    ImageModelConfigure,
    ImageArtifact { artifact_id: String, preview_revision: u64 },
    SessionList { show_all: bool },
    SessionHistory,
    SessionOpen,
    SessionUpdate,
    ModelList { mode: ModelListMode, scope: ModelSetScope },
    ModelSet,
    McpList { detail_id: Option<String> },
    LaneList,
    LaneStatus,
    LaneClose,
    LaneCreate { seed_context: Option<String> },
    SkillsList { query: Option<String>, scope: Option<SkillsScopeFilter> },
    ContextInspect,
    Logout,
    ShellExec,
    ShellStart,
    ShellWait,
    ShellDetach,
    TaskList,
    TaskStatus,
    TaskCancel,
    ThemeSet,
    RunStart,
    RunSteer { client_steer_id: String },
    RunCancel,
    Upload(PendingUpload),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PendingRpcSlot {
    Initialize, AutoReview, ShellRules, ImageModelGet, ImageModelConfigure,
    ImageArtifact, SessionList, SessionHistory, SessionOpen, SessionUpdate,
    ModelList, ModelSet, McpList, LaneList, LaneStatus, LaneClose, LaneCreate,
    SkillsList, ContextInspect, Logout, ShellExec, ShellStart, ShellWait,
    ShellDetach, TaskList, TaskStatus, TaskCancel, ThemeSet, RunStart,
    RunCancel, Upload,
}

#[derive(Debug, Default)]
pub struct PendingRpcs {
    by_id: HashMap<String, PendingRpc>,
    slot_ids: HashMap<PendingRpcSlot, String>,
    /// Tracks active server-initiated `tui_ask_user_choice` request IDs separately.
    pub client_tool_choice_ids: HashSet<String>,
}

impl PendingRpcs {
    /// Insert a singleton RPC, evicting any prior ID in the same slot (last-write-wins).
    pub fn insert_singleton(&mut self, id: String, rpc: PendingRpc) -> Option<(String, PendingRpc)>;
    /// Insert a multi-in-flight RPC (`RunSteer`).
    pub fn insert_multi(&mut self, id: String, rpc: PendingRpc);
    /// O(1) response match + cleanup (updates both `by_id` and `slot_ids`).
    pub fn take(&mut self, response_id: &str) -> Option<PendingRpc>;
    /// Remove the active entry for a singleton slot (e.g., `clear_log`, send failure).
    pub fn remove_slot(&mut self, slot: PendingRpcSlot) -> Option<(String, PendingRpc)>;
    pub fn has_slot(&self, slot: PendingRpcSlot) -> bool;
    pub fn slot_id(&self, slot: PendingRpcSlot) -> Option<&str>;
    pub fn slot_entry(&self, slot: PendingRpcSlot) -> Option<(&str, &PendingRpc)>;
    pub fn has_auto_start_blockers(&self) -> bool;
    pub fn has_shell_rule_run(&self) -> bool;
}
```

---

### 4.2 `OverlayState` (3-Layer Model: `RuntimeDialogs` + `LocalPanel` + `QueueFocus`)

To preserve concurrent runtime UI requests (**P0-1**), `QueueSteer` coexistence (**P1-7**), onboarding `PickRequest` reply obligations (**P1-7**), and `UpdatePicker` drawn-cell safety (**P1-9**), overlays are structured in **three explicit priority tiers** (with `ImagePreview` preempted whenever any tier is active):

```rust
/// Tier 1 (Highest priority): Server-driven modals with reply obligations.
/// Three independent slots preserve coexistence when runtime sends unserialized
/// prompt/confirm/client-tool-choice requests concurrently.
/// Priority order for both rendering and key dispatch: confirm > prompt > pick.
pub enum ConfirmSlot {
    /// Arrived from runtime; blocks input until 1 rendered frame completes.
    Pending(ConfirmDialogState),
    /// Active confirm dialog with its own reason input buffer.
    Active {
        state: ConfirmDialogState,
        input: InputState,
    },
}

pub struct PromptSlot {
    pub state: PromptDialogState,
    pub input: InputState,
}

pub enum RuntimePickKind {
    Standard,
    Approval { review_offset: Option<usize> },
    ClientToolChoice,
    /// Onboarding model selection triggered by a runtime `ui.pick.request`
    /// (`ModelListSubmitAction::PickRequest`). Lives in Tier 1 because it carries
    /// a mandatory runtime reply obligation and must never be silently dropped by a local panel.
    OnboardingModelList(ModelListPanelState),
}

pub struct RuntimePickDialog {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
    pub kind: RuntimePickKind,
}

#[derive(Default)]
pub struct RuntimeDialogs {
    pub confirm: Option<ConfirmSlot>,
    pub prompt: Option<PromptSlot>,
    pub pick: Option<RuntimePickDialog>,
}

/// Tier 2: User-initiated / local-only panels (mutually exclusive with each other).
/// Resolves today's view-vs-key ordering mismatch between `context_panel` and `skills`/`theme`.
pub enum LocalPanel {
    SessionList(SessionListPanelState),
    LaneList(LaneListPanelState),
    Context(ContextPanelState),
    SkillsList(SkillsListPanelState),
    ThemeList(ThemeListPanelState),
    ModelList(ModelListPanelState),      // local `/model` list only (no PickRequest obligation)
    ProviderPicker(ProviderPickerState),
    ModelPicker(ModelPickerState),
    ReasoningPicker(ReasoningPickerState),
    ShellRulePicker(ShellRulePickerState),
    UpdatePicker(UpdatePickerState),     // `/update` and startup update picker
}

/// Tier 3: Bottom-priority queue steer focus, preserved underneath transient local panels
/// (such as `tui_open_selector` / `tui_preview_artifact` opening `Context` during an active run).
#[derive(Default)]
pub struct OverlayState {
    pub runtime_dialogs: RuntimeDialogs,
    pub local_panel: Option<LocalPanel>,
    pub queue_focus: Option<QueueSteerPicker>,
}
```

#### Key Behavioral Contracts for `OverlayState`

1. **`render_state.confirm_phase` removal**: `ConfirmPhase` (`None | Pending | Active`) is replaced directly by `runtime_dialogs.confirm: Option<ConfirmSlot>`. Both `clear_log()` (`methods.rs:432-437`) and `assert_render_invariants()` (`methods.rs:518-532`) simplify accordingly.
2. **Single `top()` priority**: `RuntimeDialogs::top()` defines `confirm > prompt > pick` once; both `view/ui/panels/mod.rs` and `event_loop/input.rs` dispatch through it.
3. **`UpdatePicker` drawn-cell check**: Both `view/ui/mod.rs::drawn_update_choice` and `entry/run_loop.rs`'s `size_before` guard MUST check:
   `!app.overlays.runtime_dialogs.is_any_open() && matches!(app.overlays.local_panel, Some(LocalPanel::UpdatePicker(_)))`.
4. **`client_tools.rs:384` busy policy**: Keep `tui_ask_user_choice` rejecting when `runtime_dialogs.pick.is_some()` (and explicitly document whether local `UpdatePicker` / `ShellRulePicker` also blocks it; keeping `runtime_dialogs.pick.is_some() || matches!(local_panel, Some(LocalPanel::UpdatePicker(_) | LocalPanel::ShellRulePicker(_)))` preserves exact current behavior).
5. **Client-tool panel replacement**: When `tui_open_selector` or `tui_preview_artifact` opens `LocalPanel::Context`, it replaces only `local_panel` (leaving `runtime_dialogs` and `queue_focus` untouched).
6. **Intentional UX consistency fix — `PasteTarget` tightening**:
   - Today `blocks_composer_paste` (`event_loop/input.rs:385-397`) omitted `session_list_panel`, `context_panel`, `model_list_panel`, `provider_picker`, and `model_picker`, allowing paste into an invisible composer behind those panels.
   - Under `OverlayState::paste_target(image_preview_open, startup_pending)`:
     - `image_preview_open` → `PasteTarget::Blocked` (highest priority)
     - `runtime_dialogs.top()` is `Prompt` → `PasteTarget::RuntimePrompt` (even when `startup_pending == true`, preserving `run_loop.rs:221`; `Alt+V` preserves its status message per `input.rs:399-409`)
     - any other `runtime_dialogs` open → `PasteTarget::Blocked`
     - `startup_pending` or `local_panel.is_some()` or `queue_focus_active` → `PasteTarget::Blocked`
     - otherwise → `PasteTarget::Composer`
   - **Explicitly recorded as a minor UX bug fix** (not silent behavior drift), covered by per-panel unit tests.

---

### 4.3 `ParsedOutput` → Typed `RuntimeMsg` Enum

Replacing the 34-field `ParsedOutput` struct with a discriminated `RuntimeMsg` enum ensures one decoded wire line maps to one explicit semantic case:

```rust
pub enum RuntimeMsg {
    /// Non-actionable wire message. Note: today `apply_parsed_output` returns
    /// `needs_redraw = true` even for empty outputs (`parsed_output.rs:723`);
    /// Phase 3 will document whether `Ignored` returns `needs_redraw = false`
    /// (verified against all existing tests).
    Ignored,
    /// Pure log lines (diagnostics, raw runtime log, protocol mismatch warning,
    /// or replayed `steer_applied` display lines).
    LogLines(Vec<LogLine>),
    /// Response to an outgoing client RPC.
    RpcResponse(RpcResponse),
    /// Server-initiated UI modal requests & cancellations.
    UiRequest(ServerUiMsg),
    /// Server-initiated client tool lifecycle.
    ClientTool(ClientToolMsg),
    /// Run status, context %, LLM metrics, and goal notifications.
    RunControl(RunControlMsg),
    /// Agent transcript/tool/stream/steer/replay events (`agent.event`).
    Agent(AgentMsg),
}

pub enum ServerUiMsg {
    Confirm(UiConfirmRequest),
    Prompt(UiPromptRequest),
    Pick(UiPickRequest),
    PickCancelled { id: String },
}

pub enum ClientToolMsg {
    Call(ClientToolRequest),
    Cancel(ClientToolCancel),
    /// Malformed `client.tool.call`: carries both the rejection reply metadata
    /// and the protocol-mismatch diagnostic lines (`parser.rs:55-62`).
    RejectMalformed {
        rejection: ClientToolRejection,
        lines: Vec<LogLine>,
    },
}

pub enum RunControlMsg {
    Status {
        status: String,
        run_id: Option<String>,
        run_error: Option<RunErrorPresentation>,
        lines: Vec<LogLine>,
        unconsumed_steer_ids: Vec<String>,
        unconsumed_client_steer_ids: Option<Vec<String>>,
    },
    Context { left_percent: Option<u8> },
    Metrics(LlmMetricsUpdate),
    Goal(GoalNotification),
}

pub enum AgentMsg {
    StreamDelta(StreamUpdate),
    Text { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    Reasoning { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    Final { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    StreamReset { lines: Vec<LogLine>, run_id: Option<String> },
    /// Replayed `tui_show_progress` call/result or `done` tool result that updates
    /// replay progress ONLY without registering a pending live component line
    /// (`events.rs:212-220`, `events.rs:262-267`).
    ReplayProgress { event: ReplayProgressEvent, lines: Vec<LogLine> },
    ToolCallStart {
        tool_call_id: String,
        lines: Vec<LogLine>,
        replay_progress: Option<ReplayProgressEvent>,
    },
    ToolCallResult {
        update: ToolCallResultUpdate,
        lines: Vec<LogLine>,
        replay_progress: Option<ReplayProgressEvent>,
    },
    PermissionPreview { update: Option<PermissionPreviewUpdate>, lines: Vec<LogLine> },
    PermissionReady { update: Option<PermissionReadyUpdate>, lines: Vec<LogLine> },
    Compaction { started: bool, completed: bool, lines: Vec<LogLine> },
    SteerApplied {
        steer_id: String,
        client_id: Option<String>,
        run_id: Option<String>,
        lines: Vec<LogLine>,
    },
    UnreadableSteerApplied { run_id: Option<String>, lines: Vec<LogLine> },
}
```

---

### 4.4 Scoped `Effect` Enum (Non-RPC Shell Side Effects Only)

```rust
pub(crate) enum Effect {
    SetMouseCapture(bool),
    WriteClipboard { text: String, success_notice: String },
    StartClipboardImport,
    StartUpdateControl(UpdateControlAction),
    /// Note: `image_preview.close()` is pure state mutation and stays inside `update()`.
    /// Worker thread spawn for `image_preview` stays encapsulated in `ImagePreview`
    /// unless explicitly migrated in a later follow-up.
}
```

- `ExitAction` (`None | DrawThenExit | ExitNow`) lives on `UpdateResult`, never duplicated inside `Effect`.
- `ImagePreview`'s background decoder thread remains encapsulated in `app/image_preview/` for this track (only its key/preemption hooks go through `update()`), while `ClipboardImport` and `PendingUpdateControl` subprocess/thread launches can be triggered via `Effect` so `self_update` and clipboard transitions are 100% pure in tests.
- To unit-test `entry/run_loop.rs` (tick order, `ConfirmSlot::Pending -> Active` 1-frame delay, double `Ctrl+C`), generalize the loop runner over `B: ratatui::backend::Backend` (using `TestBackend` in unit tests).

---

## 5. Dependency Direction & Breaking the 5 Cycles

Target one-way dependency stack:

```text
L1  main.rs / entry/* (CLI, LaunchContext parsing, bootstrap, run_loop, EffectRunner)
        ↓
L2  app/frame.rs (draw_ui + apply_terminal_effects orchestrator)
    event_loop/input.rs + app/handlers/* + handlers/runtime_response/*
        ↓
L3  app/app_state + app/runtime (client/parser) + app/view + app/render/inline
        ↓
L4  app/state (pure data, no I/O) + app/shared_ui (theme/markdown/log_wrap/transcript)
        ↓
L5  app/util (zero upward imports into state/app/entry) + codelia-protocol (external crate)
```

Exact resolutions for the 5 measured cyclic/reverse edges (1 commit per cycle in Phase 1):

| # | Current Cycle / Reverse Edge | Exact Fix |
| :--- | :--- | :--- |
| 1 | `app_state/mod.rs:70,187,334 -> handlers/command/upload.rs` | Extract `SubmissionFiles`, `PendingUpload`, `UploadLimits` into `app/state/upload.rs` with clean `pub(crate)` constructors/accessors (keeping `snapshot(&AppState)` / RPC upload logic in `handlers/command/upload.rs`). |
| 2 | `event_loop/input.rs:13 -> entry/terminal.rs` | On `F2`, return an explicit mouse-capture toggle request (later `Effect::SetMouseCapture(bool)`) handled by `entry/run_loop.rs`, removing `entry::terminal` from `event_loop/input.rs`. |
| 3 | `runtime/client.rs`, `self_update.rs`, `startup_confirmations.rs -> entry/launch_context.rs` | **Keep `LaunchContext` (which reads `env::args` via `OnceLock`) in `entry/`**—never move process-arg I/O into `app/state/`. Pass `Option<&RuntimeLaunch>` into `spawn_runtime()`, and construct `LauncherPaths` / `StartupConfirmations` in `entry/bootstrap.rs` from extracted primitive fields. |
| 4 | `util ⇄ state / image_preview`: `util/clipboard/mod.rs:301,497` & `util/attachments/staging.rs:219` → `image_preview::validate_dimensions`; `util/user_message.rs:1` → `state::{LogKind, LogLine}`; `util/attachments/mod.rs:8` → `state::InputState`; `state/log/mod.rs:1` → `util::text` | (a) Move `validate_dimensions` to `app/util/image.rs`; (b) move `util/user_message.rs` to `app/state/log/user_message.rs`; (c) move `InputState`-dependent token helpers from `util/attachments/mod.rs` into `app/state/input/attachments.rs`. Result: `app/util/*` has **zero** imports of `state`, `app_state`, `image_preview`, `handlers`, or `entry`. |
| 5 | `app/render/frame.rs:2 -> app/view::draw_ui` | Move `app/render/frame.rs` (and `frame_tests.rs`) to `app/frame.rs` (update imports in `run_loop.rs`, `image_preview/tests.rs`, `scrollback_ansi_tests.rs`). `app/render/` then owns only `inline.rs` + scrollback tests and never imports `app/view`. |

After all 5 commits land, add a Rust unit test scanning `crates/tui/src/**/*.rs` (non-test sections) to forbid regressions across `app_state -> handlers`, `util -> state/app/entry`, `render -> view`, `runtime -> entry`, `app -> entry`, and `view -> handlers`.

---

## 6. Verification Strategy

Every phase runs and must pass:

1. `cargo fmt --manifest-path crates/tui/Cargo.toml -- --check`
2. `cargo test --manifest-path crates/tui/Cargo.toml`
3. `CODELIA_TUI_COLOR_SCHEME=light cargo test --manifest-path crates/tui/Cargo.toml`
4. `cargo clippy --manifest-path crates/tui/Cargo.toml --all-targets` — verify **no new warnings** introduced by touched files (clippy is not a CI gate today).
5. **CI-equivalent headless xterm scrollback check** (whenever `render/`, `view/`, `log_wrap.rs`, `app/frame.rs`, or `runtime/parser` is touched):
   ```bash
   CODELIA_TUI_CAPTURE_PATH=/tmp/codelia-tui-scrollback.jsonl \
     cargo test --manifest-path crates/tui/Cargo.toml --locked inline_native_scrollback_ansi_capture -- --nocapture
   node scripts/check-tui-scrollback.mjs /tmp/codelia-tui-scrollback.jsonl
   node --test scripts/check-tui-scrollback.test.mjs
   ```
   *(Requires `@xterm/headless` installed in `node_modules` / CI environment.)*
6. **Production PTY image preview check** (mandatory in Phase 4a–4c when overlay preemption changes):
   `python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui`
7. `bun run check:protocol && bun run typecheck` (confirm workspace protocol/TS contracts remain untouched).
