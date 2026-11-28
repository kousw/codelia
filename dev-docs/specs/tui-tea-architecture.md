# TUI TEA Architecture & Migration Spec

Status: `Implemented`

This document defines the pragmatic **TEA (The Elm Architecture)** implemented in `crates/tui`.
It builds on [`tui-architecture.md`](./tui-architecture.md), [`tui-render-state-machine.md`](./tui-render-state-machine.md), [`tui-owned-text-selection.md`](./tui-owned-text-selection.md), [`tui-image-preview.md`](./tui-image-preview.md), and [`ui-protocol.md`](./ui-protocol.md).

---

## 1. Migration Status

All phases are implemented.

| Phase | Implemented contract |
| :--- | :--- |
| 0 | Object-safe `RuntimeTx` and in-memory `MockRuntimeTx` with send-failure injection. |
| 1 | One-way production module dependencies, guarded by the import-hygiene test in `src/main_tests.rs`. |
| 2 | `PendingRpcs` with typed metadata, singletons and concurrent steers (§4.1). |
| 3 | Typed `RuntimeMsg` and per-line application (§4.3). |
| 4a–4c | Independent runtime dialog slots, one local panel, queue focus, shared paste routing and dedicated pick roles (§4.2). |
| 5 | `Msg`, `update`, scoped non-RPC effects and a generic terminal runner (§3 and §4.4). |

`AppState` remains the model. Ratatui owns rendering and inline native scrollback. The migration adds no external TEA framework and leaves the wire protocol unchanged. The overlay work also fixed paste routing behind covered composers (§4.2).

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

## 3. Pragmatic TEA Architecture

### 3.1 Core Loop & `RuntimeTx` Boundary

```rust
/// Minimal object-safe runtime RPC writer + ID allocator.
/// StdioRuntimeTx owns the ID counter and borrows the buffered child stdin.
/// MockRuntimeTx records writes in memory and supports write-error injection.
pub(crate) trait RuntimeTx {
    fn next_id(&mut self) -> String;
    fn send_line(&mut self, line: &str) -> std::io::Result<()>;
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitAction {
    #[default]
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
    pub(crate) skip_post_input_tick: bool,
}

pub(crate) fn update(app: &mut AppState, msg: Msg<'_>, tx: &mut dyn RuntimeTx) -> UpdateResult { ... }
```

RPC sends stay synchronous through `&mut dyn RuntimeTx` so each handler can apply its own rollback. On a send failure, `goal.continue` keeps the `RunStart` slot and checks status immediately. Upload pauses the submission and installs a pending entry only after the write succeeds. Queue, steer and image handlers likewise own their recovery. `Effect` carries terminal control, clipboard writes and local worker launches.

### 3.2 Messages and Tick Order

`event_loop/update.rs` defines the message boundary.

```rust
pub(crate) enum Msg<'a> {
    Runtime(RuntimeMsg),
    Local(LocalMsg),
    PreDrawTick {
        startup_pending: bool,
        pending_initial_message: &'a mut Option<String>,
    },
    Terminal(TerminalInput),
    PostInputTick { now: Instant, startup_pending: bool },
}
```

`TerminalInput` carries the event, clock value, startup snapshot, alternate-mode selection gate, dirty-frame flag, and drawn-choice size check. `LocalMsg` carries preview and startup poll hooks, update and clipboard completions, child exit status, and sampled memory.

1. **Drain up to 300 runtime lines.** Parse each line against the live `SessionHistory` slot and active run ID. Apply `Msg::Runtime` before reading the next line. Hitting the cap requests redraw and yields to the rest of the tick.
2. **Apply local updates.** Preempt the image preview when `app.has_interaction_panel()`, then poll it inside its feature module. Apply update-control completion, poll startup confirmations, then apply clipboard import completions.
3. **Apply `PreDrawTick`.** Request the skills catalog when eligible. With startup complete, try the initial message, then queued dispatch. The shell checks `child.try_wait()` afterward only while no exit is pending. An observed exit generates `LocalMsg::RuntimeExited`, which logs the status and returns `DrawThenExit`.
4. **Synchronize terminal mouse capture, then draw when requested.** The shell calls `draw_frame` inside synchronized update. Capture the terminal size before the frame only for an uncovered update picker. Keep it only if the selected option was drawn and the terminal size stayed stable. If a pending confirm promotes after the frame, redraw and continue before polling input. Honor `DrawThenExit` after this confirm check.
5. **Poll input for 50 ms.** Pass the event through `Msg::Terminal`. Only press events reach the key handlers. Non-press events, image preview keys and a handled first Ctrl+C set `skip_post_input_tick`. A second Ctrl+C within two seconds logs `Force quitting...` and returns `ExitNow`, without drawing again. Enter invalidates an update choice if its recorded size differs from the live size. Resize clears drawn choice and text selection. Paste reaches the next step even if blocked.
6. **Apply `PostInputTick`.** Tick goals when startup permits, update the spinner, and expire the selection notice. With `--debug-perf`, the shell samples TUI and child memory at intervals of at least one second and feeds the result through `Msg::Local`.

### 3.3 Mutation contract for `draw_ui(frame, &mut AppState)`

`draw_ui` stays `pub fn draw_ui(f: &mut Frame<'_>, app: &mut AppState)` rather than splitting `(&AppState, &mut RenderCache)` (which conflicts with Rust's borrow checker because `flush_stream_output()` mutates `log` and scroll clamping mutates `scroll_from_bottom`).

Instead, we enforce a clear explicit rule on what `draw_ui` may mutate:
- Allowed mutations during `draw_ui`:
  - `render_state` and wrap/hit-map cache fields (`wrapped_log_cache`, `last_wrapped_total`, `last_wrap_width`, `last_log_viewport_height`, `transcript_hit_map`, `transcript_frame_revision`)
  - `flush_stream_output()` (flushing pending live stream deltas into `log` before wrapping)
  - viewport scroll stabilization / clamping (`scroll_from_bottom`) and acknowledging `log_changed`
  - invalidating `text_selection` when `selection_input_blocked()` or layout invalidates projection
  - recording `image_preview.desired_size`
- The view resets `scroll_from_bottom` while a confirm or prompt is visible as part of viewport adjustment.

---

## 4. Core Interface Designs

### 4.1 `PendingRpcs` (Replacing 35 `Option<String>` Fields)

#### Concurrency & Precedence Rules

1. **Singleton slots (`PendingRpcSlot`) — Last-Write-Wins**:
   - Each `PendingRpc` variant except `RunSteer` occupies a named `PendingRpcSlot` (including `ImageArtifact`, which is single-slot: `command/image.rs` checks `has_slot(PendingRpcSlot::ImageArtifact)` and rejects concurrent requests).
   - `PendingRpcs::insert(id, rpc)` **evicts any prior request ID occupying the same `PendingRpcSlot`** (returning the evicted `(old_id, old_rpc)` if any), so evicted responses fall through as unmatched.
   - `PendingRpcs::remove_slot(slot)` removes the active entry for a slot (used by `clear_log()` for `ImageArtifact` and by `image.rs` error cleanup across all 3 image slots).
2. **Multi-in-flight (`RunSteer`)**:
   - `PendingRpcs::insert(id, PendingRpc::RunSteer { client_steer_id })` allows multiple concurrent in-flight steer RPCs keyed by `request_id`.
3. **Separate trackers & response routing precedence**:
   - Keep `goal` request tracking (in `app.goal`, with `goal.continue` sharing the `RunStart` slot) and server-initiated `client_tool_choice_ids: HashSet<String>` outside `PendingRpcs::by_id`.
   - `handlers/runtime_response/mod.rs` gives `goal::handle_response` first chance to consume the response. Then `app.rpc_pending.take(&response.id)` dispatches by typed variant, including `PendingRpc::Upload` to `upload::handle_response`. The unmatched response path handles the remainder.
4. **Explicit auto-start blocker table**:
   - `PendingRpcSlot::blocks_auto_start(self) -> bool` is an explicit exhaustive `match` (locked by unit test), intentionally returning `false` for `Initialize`, `RunStart`, `RunCancel`, and `Upload` (and `RunSteer` has no slot / is excluded), matching `PendingRpcs::has_auto_start_blockers()` in `app/app_state/pending_rpcs.rs`.
   - `PendingRpcs::has_shell_rule_run(&self) -> bool` explicitly checks for `PendingRpc::ShellRules(ShellRuleRpc::Run { .. })` (preserving `can_dispatch_prompt_now()`).

```rust
#[derive(Debug)]
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
    LaneCreate,
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
    /// Insert a pending RPC; singletons evict and return any prior entry in the same slot,
    /// while multi-in-flight variants (`RunSteer`) coexist across distinct IDs.
    pub fn insert(&mut self, id: String, rpc: PendingRpc) -> Option<(String, PendingRpc)>;
    /// O(1) response match + cleanup (updates both `by_id` and `slot_ids`).
    pub fn take(&mut self, response_id: &str) -> Option<PendingRpc>;
    /// Remove the active entry for a singleton slot (e.g., `clear_log`, send failure).
    pub fn remove_slot(&mut self, slot: PendingRpcSlot) -> Option<(String, PendingRpc)>;
    pub fn has_slot(&self, slot: PendingRpcSlot) -> bool;
    pub fn slot_id(&self, slot: PendingRpcSlot) -> Option<&str>;
    pub fn slot_entry(&self, slot: PendingRpcSlot) -> Option<(&str, &PendingRpc)>;
    pub fn has_auto_start_blockers(&self) -> bool;
    pub fn has_shell_rule_run(&self) -> bool;
    pub fn upload(&self) -> Option<&PendingUpload>;
    pub fn take_upload(&mut self) -> Option<PendingUpload>;
    pub fn set_upload(&mut self, upload: PendingUpload);
    pub fn has_run_steers(&self) -> bool;
    pub fn clear_run_steers(&mut self);
}
```

---

### 4.2 `OverlayState` (3-Layer Model: `RuntimeDialogs` + `LocalPanel` + `QueueFocus`)

The three overlay tiers preserve concurrent runtime requests, queue focus, onboarding pick replies and update-picker draw validation. Any active tier preempts image preview.

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

pub enum RuntimePickListKind {
    Standard,
    Approval { review_offset: Option<usize> },
    ClientToolChoice,
}

pub struct RuntimePickList {
    pub id: String,
    pub title: String,
    pub message: Option<String>,
    pub items: Vec<PickDialogItem>,
    pub selected: usize,
    pub multi: bool,
    pub chosen: Vec<bool>,
    pub kind: RuntimePickListKind,
}

pub enum RuntimePickDialog {
    List(RuntimePickList),
    /// Onboarding `ui.pick.request` with a mandatory runtime reply.
    OnboardingModelList {
        request_id: String,
        panel: Box<ModelListPanelState>,
    },
}

#[derive(Default)]
pub struct RuntimeDialogs {
    pub confirm: Option<ConfirmSlot>,
    pub prompt: Option<PromptSlot>,
    pub pick: Option<RuntimePickDialog>,
}

/// Tier 2: User-initiated / local-only panels (mutually exclusive with each other).
pub enum LocalPanel {
    SessionList(SessionListPanelState),
    LaneList(LaneListPanelState),
    Context(ContextPanelState),
    SkillsList(SkillsListPanelState),
    ThemeList(ThemeListPanelState),
    ModelList {
        panel: ModelListPanelState,
        scope: ModelSetScope,
    },
    ProviderPicker(ProviderPickerState),
    ModelPicker(ModelPickerState),
    ReasoningPicker(ReasoningPickerState),
    UpdatePicker(UpdatePickerState),     // `/update` and startup update picker
    ShellRulePicker(ShellRulePickerState),
    LaneActionPicker(LaneActionPickerState),
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

1. **`render_state.confirm_phase` removal**: `ConfirmPhase` (`None | Pending | Active`) is replaced directly by `runtime_dialogs.confirm: Option<ConfirmSlot>`. Both `AppState::clear_log()` and `AppState::assert_render_invariants()` in `app/app_state/methods.rs` simplify accordingly.
2. **Runtime dialog priority**. Input uses `RuntimeDialogs::top()` with `confirm > prompt > pick`. Rendering uses `visible_top()`, which skips a pending confirm until activation.
3. **`UpdatePicker` drawn-cell check**: Both `view/ui/mod.rs::drawn_update_choice` and `entry/run_loop.rs`'s `size_before` guard MUST check:
   `!app.overlays.runtime_dialogs.is_any_open() && matches!(app.overlays.local_panel, Some(LocalPanel::UpdatePicker(_)))`.
4. **Client-tool & runtime pick arbitration**. `tui_ask_user_choice` returns `"pick dialog is busy"` when a runtime pick or a local `UpdatePicker` or `ShellRulePicker` is open. `tui_open_selector` and `tui_preview_artifact` likewise reject with `"pick dialog is busy"` while `UpdatePicker` or `ShellRulePicker` is open so local pickers are not silently clobbered. An incoming `ui.pick.request` replies `"choice superseded"` to a displaced client-tool choice and removes its tracked request ID; if another server-owned runtime pick (`Standard`, `Approval`, or `OnboardingModelList`) is already open, the existing pick stays open and the incoming `ui.pick.request` is declined with `ids: []`. `ui.pick.cancelled` only cancels server-owned picks (never `ClientToolChoice`, which belongs to `client.tool.cancel`).
5. **Client-tool panel replacement**. `tui_open_selector` and `tui_preview_artifact` set `local_panel` to `LocalPanel::Context` (unless blocked by an open `UpdatePicker` or `ShellRulePicker`). Runtime dialogs and queue focus retain their own state.
6. **Unified `PasteTarget` routing**:
   - `OverlayState::paste_target(image_preview_open, startup_pending)` resolves the owner in priority order.
     - `image_preview_open` → `PasteTarget::Blocked` (highest priority)
     - `runtime_dialogs.top()` is `Prompt` → `PasteTarget::RuntimePrompt` even during startup. `Alt+V` shows the composer-only notice.
     - any other `runtime_dialogs` open → `PasteTarget::Blocked`
     - `startup_pending` or `local_panel.is_some()` or `queue_focus_active` → `PasteTarget::Blocked`
     - otherwise → `PasteTarget::Composer`
   - Per-panel tests cover paste blocking behind the overlay.

7. **Model list submission and cancellation**. `LocalPanel::ModelList` carries the scope for `model.set`. `RuntimePickDialog::OnboardingModelList` carries the request ID for `ui.pick.request`. Both share the display rows and selected item index in `ModelListPanelState`. `ui.pick.cancelled` dismisses a matching pick through `RuntimePickDialog::id()`.
8. **Startup update picker**. Startup opens `LocalPanel::UpdatePicker` with `startup: true`. Any open runtime dialog clears the startup picker from the local tier. The pending startup confirmation opens it again once the runtime dialogs close and the other startup gates allow it.

---

### 4.3 `ParsedOutput` → Typed `RuntimeMsg` Enum

Replacing the 34-field `ParsedOutput` struct with a discriminated `RuntimeMsg` enum ensures one decoded wire line maps to one explicit semantic case:

```rust
pub enum RuntimeMsg {
    /// Non-actionable wire message; `apply_runtime_msg` returns `false` (no redraw).
    /// Note: hitting `MAX_RUNTIME_LINES_PER_TICK` (300) still forces a redraw so the
    /// UI yields and drains remaining queued lines on the next tick, while non-ignored
    /// variants (`LogLines`, `RpcResponse`, etc.) keep returning `true` for parity.
    Ignored,
    /// Pure log lines (diagnostics, raw runtime log, protocol mismatch warning,
    /// or replayed `steer_applied` / `llm.retry` display lines).
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
    /// and the protocol-mismatch diagnostic lines.
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

pub enum CompactionPhase { Started, Completed }

pub enum AgentMsg {
    StreamDelta(StreamUpdate),
    Text { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    Reasoning { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    Final { lines: Vec<LogLine>, content: String, canonical_run_id: Option<String> },
    StreamReset { lines: Vec<LogLine>, run_id: Option<String> },
    /// Replayed `tui_show_progress` call/result that updates replay progress ONLY
    /// without registering a pending live component line.
    ReplayProgress(ReplayProgressEvent),
    ToolCallStart {
        tool_call_id: String,
        lines: Vec<LogLine>,
    },
    ToolCallResult {
        update: ToolCallResultUpdate,
        lines: Vec<LogLine>,
        replay_progress: Option<ReplayProgressEvent>,
    },
    PermissionPreview { update: Option<PermissionPreviewUpdate>, lines: Vec<LogLine> },
    PermissionReady { update: Option<PermissionReadyUpdate>, lines: Vec<LogLine> },
    Compaction { phase: CompactionPhase, lines: Vec<LogLine> },
    SteerApplied {
        steer_id: String,
        client_id: Option<String>,
        run_id: String,
        lines: Vec<LogLine>,
    },
    UnreadableSteerApplied { run_id: Option<String>, lines: Vec<LogLine> },
}
```

---

### 4.4 Scoped `Effect`

```rust
pub(crate) enum Effect {
    SetMouseCapture(bool),
    WriteClipboard { text: String },
    StartClipboardImport,
    StartUpdateControl(UpdateControlAction),
}

pub(crate) enum UpdateControlAction {
    Status,
    Save(UpdateMode),
}

pub(crate) enum UpdateMode {
    Notify,
    Auto,
    Off,
}
```

`app/effect.rs` owns these shared types. Initial mouse-capture setup happens once during terminal initialization in `main.rs`; interactive toggles (`F2`) emit `Effect::SetMouseCapture`, which the shell applies right before the next draw. It returns clipboard write results as `LocalMsg::ClipboardWritten`, which sets the notice and its expiry. The clipboard import effect starts the worker after main-key handling has pruned unreferenced attachments. `LocalMsg::ClipboardImportStarted` inserts the composer marker on success or logs status on failure without re-pruning. The update-control effect starts the local launcher helper. Its status/save result is applied separately through `LocalMsg::UpdateControl`. The image preview decoder remains encapsulated in `app/image_preview/`.

`entry/run_loop.rs` retains the production `run_tui_loop` entry point. The inner runner is generic over `B: Backend`. Its `LoopIo<B>` adapter supplies terminal events, child status and PID, the clock, effect execution, and synchronized drawing. Tests pair a scripted adapter with Ratatui `TestBackend` and `MockRuntimeTx`.

---

## 5. Dependency Direction

```text
main.rs → entry (startup, terminal, runtime child, run loop, effects)
              → event_loop (update, input) → app/handlers
              → app/frame → app/view and app/render/inline

app/handlers, app/view, app/render → app state and shared presentation
app/handlers → app/runtime (RPC client and parser)
app state and app/runtime → app/state, app/util, codelia-protocol as needed
```

The import-hygiene test in `src/main_tests.rs` enforces production boundaries.
`event_loop` and `app` are independent of `entry`, with launch settings passed in as data.
`app` is independent of `event_loop`. `state` and `app_state` are independent of
handlers, view and render. `util` only uses other `util` modules within the app.
`app/frame.rs` composes drawing and inline scrollback while `view` and `render`
stay independent. Shared theme, Markdown and wrapping live directly under `app/`.

---

## 6. Verification Strategy

Verify changes to these contracts with:

1. `cargo fmt --manifest-path crates/tui/Cargo.toml -- --check`
2. `cargo test --manifest-path crates/tui/Cargo.toml`
3. `CODELIA_TEST_TUI_COLOR_SCHEME=light cargo test --manifest-path crates/tui/Cargo.toml`
4. `cargo clippy --manifest-path crates/tui/Cargo.toml --all-targets` — verify **no new warnings** introduced by touched files (clippy is not a CI gate today).
5. **CI-equivalent headless xterm scrollback check** (whenever `render/`, `view/`, `log_wrap.rs`, `app/frame.rs`, or `runtime/parser` is touched):
   ```bash
   export CODELIA_TEST_TUI_EMULATOR_DIR=/tmp/codelia-tui-emulator
   export CODELIA_TEST_TUI_CAPTURE_PATH=/tmp/codelia-tui-capture.json
   npm install --prefix "$CODELIA_TEST_TUI_EMULATOR_DIR" --ignore-scripts --no-audit --no-fund --package-lock=false @xterm/headless@6.0.0
   unset NO_COLOR
   cargo test --manifest-path crates/tui/Cargo.toml --locked inline_native_scrollback_ansi_capture
   node --test scripts/check-tui-scrollback.test.mjs
   ```
6. **Production PTY image preview check** (when preview input or overlay preemption changes):
   `python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui`
7. `bun run check:protocol && bun run typecheck` (confirm workspace protocol/TS contracts remain untouched).
