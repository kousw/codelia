# TUI Operation Reference

Status: `Implemented` (current `crates/tui` behavior summary)

This document collects day-to-day operational behavior for the Rust TUI.
Architecture and rendering internals are defined in separate specs:

- `docs/specs/tui-architecture.md`
- `docs/specs/tui-render-state-machine.md`
- `docs/specs/tui-terminal-mode.md`
- `docs/specs/ui-protocol.md`

## 1. Command Surface

Slash commands available in composer:

- `/help`: print command list to log
- `/compact`: send `run.start(force_compaction=true)`
- `/model [provider/]name`: set model directly or open provider/model picker
- `/context [brief]`: call `context.inspect`
- `/skills [query] [all|repo|user] [--reload] [--scope <...>]`: open skills picker
- `/mcp [server-id]`: call `mcp.list(scope="loaded")` and optionally show one server detail
- `/logout`: send `auth.logout(clear_session=true)` after confirmation
- `/lane`: open lane interactive flow (`lane_list` panel + `Status`/`Close`/`+ New lane`)

Composer assistance behavior:

- If input starts with `/`, command suggestion panel is shown.
- If trailing token is `$skill-prefix`, local skill suggestion panel is shown.
- `Tab` tries slash completion first, then `$skill` completion.
- Unknown slash command is not sent as user message; TUI prints `command not found` with `/help` hint.

## 2. Input and Dialog Behavior

- `Enter`: submit composer input (`run.start`) in normal mode.
- `Ctrl+J`: insert newline (fallback across terminals/IME).
- `Shift+Enter`: newline when terminal can distinguish modifiers.
- `Esc` priority in main view:
  1. close active panel/dialog handling
  2. reset log scroll offset
  3. clear unsent composer input and pending attachments
  4. if a run is active, send one `run.cancel` request

Confirm/prompt behavior:

- `ui.confirm.request` is staged with `RenderState.confirm_phase=Pending`, then activated as `Active` after draw/sync pass.
- Confirm close forces bottom-aligned scrollback sync (`scroll_from_bottom=0`, `sync_phase=NeedsInsert`).
- `ui.prompt.request(secret=true)` masks displayed input (`*`) while preserving sent value.

## 3. Inline Rendering and Log UX

- Alternate screen is disabled; TUI renders in main buffer (inline mode).
- Overflowed log lines are inserted into terminal scrollback.
- Scrollback sync is driven by `RenderState.sync_phase` (`Idle`/`NeedsInsert`/`InsertedNeedsRedraw`).
- Visible log range starts at or after `inserted_until`; already inserted lines are not re-rendered.
- Layout-only viewport changes (confirm/prompt/input height changes) still request a sync pass when needed.

## 4. Attachments and Clipboard

- `Alt+V` tries clipboard image paste and attaches images to next `run.start`.
- On WSL, native clipboard failure falls back to Windows clipboard via `powershell.exe`.
- Composer renders image tokens as `[Image N]` labels.

## 5. Startup and Resume

- CLI baseline options:
  - `codelia --help` / `codelia -h`: prints top-level usage and common TUI passthrough flags.
  - `codelia --version` / `codelia -V` / `codelia -v`: prints CLI version.
  - `codelia-tui --help` / `codelia-tui -h`: prints direct TUI usage and exits.
  - `codelia-tui --version` / `codelia-tui -V` / `codelia-tui -v`: prints version and exits.
- Startup initializes runtime capabilities and loads current model/provider.
- Startup log prints a version line (`Version: ...`) after welcome banner.
- With resume mode (`--resume`), TUI fetches session list/history and restores log context.
- With `--initial-message` / `--initial-user-message`, TUI queues and auto-starts first prompt when idle.

## 6. Diagnostics

- `CODELIA_DEBUG=1`: runtime/RPC debug logs.
- `--debug` / `--debug=true`: runtime/RPC debug logs (same effect as `CODELIA_DEBUG=1`).
- `--debug-perf` or `CODELIA_DEBUG_PERF=1`: fixed perf panel (frame/draw/wrap-cache stats).
