# codelia-tui (`crates/tui`)

Rust inline-or-alternate-screen TUI client built with Ratatui + crossterm (`dev-docs/specs/tui-architecture.md`, `tui-tea-architecture.md`, `tui-render-state-machine.md`, `tui-terminal-mode.md`, `ui-protocol.md`, `tui-owned-text-selection.md`, `tui-inline-scrollback-validation.md`).

## Commands & Checks

- Build/check/test: `cargo run --manifest-path crates/tui/Cargo.toml`, `cargo fmt --manifest-path crates/tui/Cargo.toml`, `cargo test --locked --manifest-path crates/tui/Cargo.toml`
- Light palette tests: `CODELIA_TEST_TUI_COLOR_SCHEME=light cargo test --locked --manifest-path crates/tui/Cargo.toml`
- PTY image preview check: `python3 scripts/check-tui-image-preview.py crates/tui/target/debug/codelia-tui`
- Standalone image lab (experiment): `cargo run --manifest-path crates/tui/Cargo.toml --locked --features image-preview --example codelia-image-preview -- [local-image]` (`crates/tui/examples/image-preview/README.md`)

## Layer Boundaries (`src/main_tests.rs` checks production paths)

- `entry/*` (startup, `terminal.rs`, `ResolvedTerminalMode` `auto|inline|alternate` — never `use_alt_screen: bool`, generic `LoopIo` `run_loop.rs`, `WakeHub`) and `event_loop/*` (`update.rs` `Msg`/`UpdateResult`/`skip_post_input_tick`, `input.rs` returning `Effect`s, thin `runtime.rs`) may depend on `app/*` public APIs, never `view/*` internals. Use `app::handlers::theme::apply_theme_from_name`.
- `app/state/` and `app/app_state/` stay side-effect-free (no `view`, `render`, or `handlers`).
- `app/view/` is presentation-only (no `handlers/*` imports, no terminal side effects).
- `app/render/` owns terminal side effects (no UI composition); `app/frame.rs` coordinates `view` and `render::inline`.
- `app/util/` helpers never mutate `AppState`.

## Terminal, Rendering & Selection Invariants

- **Startup & colors**: Never send OSC terminal color/fg/bg queries at startup (delayed replies leak into composer input). Canvas text uses `Color::Reset` without `Modifier::DIM`; dark surfaces stay explicit (`panel_divider_fg` is dark-surface only; canvas diffs use `log_muted_fg`). Contrast tests must cover gray backgrounds.
- **Inline mode**: Ratatui owns `Viewport::Inline` and `Terminal::insert_before`; alternate mode never performs inline scrollback insertion. Keep Ratatui `scrolling-regions` disabled (CSI S drops native scrollback in xterm.js). Perform LF insertion via `app::frame::draw_frame` (at most one insertion pass + two draws, never insert after the final draw) and restore the viewport before polling input. `insert_history_chunk` empties wide-glyph continuation placeholders only; keep `unicode-width` aligned with Ratatui (preserve `scrollback_tests.rs` U+16FF0 / mixed-width ANSI regressions and `scrollback_ansi_tests.rs` CI checks).
- **`RenderState` & log indices**: Maintain `inserted_until <= visible_start <= visible_end <= wrapped_total`. `committed` tracks `(log index, source grapheme offset)` and advances with `inserted_until` only after the corresponding `insert_before` chunk succeeds (never rewrap between chunks; reuse rendered cache). Project `inserted_until` into the current wrapped cache (may decrease on rewrap; never store raw row indices) and stop insertion at rows exceeding viewport width. `stream_commit_boundary()` retains partial anchors if a live suffix temporarily empties. Keep log indices stable until `clear_log` (streaming may prune only trailing uncommitted lines, preserving earlier indices); replace progress rows only before commit (append a new row after commit).
- **Owned selection (`state/selection.rs`)**: Alternate mode + unmodified primary mouse gesture only. Exclude `frame_revision` from `SelectionProjectionId` (`log_version` + wrap width only). Hit-test through per-grapheme source fragments (no synthetic gutters/padding). Highlight with explicit fg/bg (never `REVERSED`, `DIM`, or `HIDDEN`). A left-button release on a dirty frame must cancel the active drag and request redraw.

## TEA, RPC & Local Feature Invariants

- **RPC & polling**: Send RPCs synchronously via `&mut dyn RuntimeTx` with `PendingRpcs` rollback (`run.steer` allows multiple IDs). Route responses in order: goal -> upload -> `rpc_pending.take` -> fallback; apply each parsed line before reading state for the next (<= 300 lines/tick; `RuntimeMsg::Ignored` requests no redraw unless cap hit).
- **Overlays (`AppState.overlays`)**: 3 tiers — `RuntimeDialogs` (`ConfirmSlot::Pending -> Active` after one draw + scrollback sync; confirm > prompt > pick), `LocalPanel` (`/update`, shell rules), and `QueueSteerPicker` (queue focus; independent 3rd tier blocking editor input while permitting queued dispatch when other gates pass). Open runtime dialogs block startup `/update` choice validation.
- **Parser & streaming (`app/runtime/parser/`, `transcript.rs`, `state/stream_preview.rs`)**: `supports_text_delta` shares `transcript.rs` Markdown rendering and `stream_commit_boundary()` fencing; `stream_preview.rs` keeps run/attempt-scoped segments without tail truncation. `last_llm_tps` updates only on valid non-null active-run metrics and clears only on logout session reset (never on call/run start). Live `tui_show_progress` calls/success results and `done` stay hidden; history replay reconstructs progress rows without sending RPCs. Legacy text `Permission request raw args (...)` stays ignored. `CODELIA_DEBUG=diff` logs parser diff-highlight diagnostics.
- **Client tools, queue, update & resume**:
  - `tui_ask_user_choice` validates all primary choices before appending `None`/`Other`; `client.tool.cancel` dismisses only a matching tracked `request_id`. Suppress client-tool injection when `CODELIA_BENCHMARK_MODE=1` and disable when `CODELIA_TUI_CLIENT_TOOLS=0`.
  - Queued prompts snapshot the final `run.start` payload, retry `busy` <= 5 times, pause on uncertain errors without auto-replaying, pause all matching queued candidates on Steer ID mismatch, and wait one backoff after terminal `run.status`.
  - `session.open` precedes `session.history` (`max_events: 500`); `/logout [provider]` requires `supports_scoped_logout`; `/model-session` / `--session` sets `scope=session`; `/update` saves global `update.mode` via private CLI controls only when the option was drawn in current terminal bounds (startup confirmation never sends local choices as runtime RPC replies).
  - Typed file clipboard (`Alt+V`) / staging (`util/clipboard/`, `util/attachments/`): accept paths only from typed file clipboard selections (not terminal text paste), reject remote URI authorities, never interpolate clipboard/selection text into command strings (use UTF-8 stdin for WSL PowerShell, bounded bridge waits), verify regular files via bounded opened handle + shared 128 MiB reservation, and replace staged markers before `run.start`; `clipboard_import.rs` binds in-flight imports to composer markers so out-of-order completions resolve in place and late completions after clear/delete/session switch leave the composer untouched.
  - Shutdown closes runtime stdin and waits up to 5s before kill/reap (including startup errors).
