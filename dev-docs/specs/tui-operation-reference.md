# TUI Operation Reference

Status: `Implemented` (current `crates/tui` behavior summary)

This document collects day-to-day operational behavior for the Rust TUI.
Architecture and rendering internals are defined in separate specs:

- `dev-docs/specs/tui-architecture.md`
- `dev-docs/specs/tui-render-state-machine.md`
- `dev-docs/specs/tui-terminal-mode.md`
- `dev-docs/specs/ui-protocol.md`

### Startup confirmations

The CLI launcher selects built-in, local confirmations for this launch. After
runtime initialization and any pending session open or runtime dialog, the TUI
presents them in order before dispatching initial or queued prompts and normal
composer input. A runtime confirmation or prompt that arrives during a startup
picker takes priority; the unanswered startup item can be shown again afterward.

`crates/tui/src/app/startup_confirmations.rs` controls ordering and waits for each
item's local completion. Each feature owns its content and persistence. The
private launcher handoff contains only known confirmation IDs, not dialog text
or executable actions. There is no runtime RPC for these local selections.
The first item is the [CLI update-mode confirmation](self-update.md#startup-confirmation).

## 1. Command Surface

Slash commands available in composer:

- `/help`: print command list to log
- `/update`: show the local CLI version and cached update candidate, and choose `notify`, `auto`, or `off`. Enter saves the global preference for later launches; Esc leaves it unchanged. Does not query npm or install updates during the session (see [CLI self-update](self-update.md)).
- `/image [local-path]`: open a local image preview, or reopen the last source; quote paths with spaces. This reads on the TUI host, never the SSH runtime host, and does not upload or invoke a model.
- `/compact`: send `run.start(force_compaction=true)`
- `/model [--session] [provider/]name`: set model directly or open provider/model picker; default persists to config, `--session` applies only to the active session and is restored on resume
- `/model-session [provider/]name|reset`: alias for session-local model switching; `reset` clears the session override
- `/fast [on|off|toggle|ultrafast]`: update current model config with `fast`; no argument toggles
- `/context [brief]`: call `context.inspect`
- `/skills [query] [all|repo|user] [--reload] [--scope <...>]`: open skills picker
- `/mcp [server-id]`: call `mcp.list(scope="loaded")` and optionally show one server detail
- `/logout [provider]`: send `auth.logout(clear_session=true, provider?)`; runtime confirms before clearing all saved credentials or only the named entry. A scoped logout preserves sessions using another provider. Named requests require `supports_scoped_logout` to prevent older runtimes from treating them as all-provider logout.
- `/lane`: open lane interactive flow (`lane_list` panel + `Status`/`Close`/`+ New lane`)
- `/errors [summary|detail|show]`: control error rendering mode and show stored last error detail
- `/queue [pick|mode [queue|steer|toggle]|steer [id|index]|retry|cancel [id|index]|clear]`: inspect/manage queued prompts and switch what plain `Enter` does while a run is active (`queue` vs `steer`).
- `/goal [<objective>|pause|resume|clear|budget <tokens|off>]`: manage the session goal. An empty argument shows the full goal, stop reason, measured tokens and budget. Pending user prompts take precedence over automatic continuation.
- `/steer <text>`: send a mid-run steer via `run.steer` (falls back to `pending_prompt_queue` if unconsumed when the run ends; submits immediately via `run.start` when idle).

Composer assistance behavior:

- If input starts with `/`, command suggestion panel is shown.
- If trailing token is `$skill-prefix`, local skill suggestion panel is shown.
- `Tab` tries slash completion first, then `$skill` completion.
- Unknown slash command is not sent as user message; TUI prints `command not found` with `/help` hint.

Implemented extension notes:

- `!<command>` direct shell execution mode is implemented (deferred injection via
  `<shell_result>` blocks). See `dev-docs/specs/tui-bang-shell-mode.md`.
  - Successful shell results keep the detail area output-only where possible; execution time is surfaced in the summary line instead of separate metadata rows.
- Prompt queueing while a run is active (`/queue` + FIFO auto-dispatch) and mid-run steer with queue fallback (`/steer`, `/queue mode|steer`, `Alt+M`) are implemented.
  Failed dispatches retain the input; `/queue retry` resumes the first paused item
  after checking whether an uncertain run already started, and `/queue cancel`
  removes it.
  See `dev-docs/specs/tui-input-queueing.md` and `dev-docs/specs/tui-run-steer.md` for behavior details.
- On TUI exit, the runtime receives stdin EOF and has up to five seconds to
  close its owned tasks and MCP clients before the TUI forcibly stops it.

## 2. Input and Dialog Behavior

- `Enter`: submit composer input (`run.start`) when idle, or queue/steer according to the active-run submit mode (`queue` default, or `steer` when `supports_run_steer` is enabled).
- `Ctrl+J`: insert newline (fallback across terminals/IME).
- `Shift+Enter`: newline when terminal can distinguish modifiers.
- `Alt+Q`: choose a queued prompt for Steer (↑/↓, Enter to send, Esc to return). `/queue pick` opens the same list.
- `Alt+M`: toggle active-run `Enter` mode between `queue` and `steer` (when `supports_run_steer` is enabled).
- `Alt+I`: preview the last composer image without consuming it; otherwise reopen the last preview. In preview, `Enter`/`Space` toggles small/modal, `Esc` returns/closes, and `q`/`v`/`Ctrl+C` closes. Other keys, paste and mouse events do not reach the composer. Runtime dialogs preempt the preview.
- `Esc` priority in main view:
  1. close active panel/dialog handling
  2. clear a transcript selection
  3. reset log scroll offset
  4. clear unsent composer input and pending attachments
  5. disarm an active goal and cancel the matching run, or send `run.cancel` for an ordinary active run

Confirm/prompt behavior:

- `ui.confirm.request` is staged with `RenderState.confirm_phase=Pending`, then activated as `Active` after draw/sync pass.
- Confirm close forces bottom-aligned scrollback sync (`scroll_from_bottom=0`, `sync_phase=NeedsInsert`).
- `ui.prompt.request(secret=true)` masks displayed input (`*`) while preserving sent value.

## 3. Terminal Rendering and Log UX

- Requested terminal modes are `auto`, `inline`, and `alternate`; the default is `auto`.
- `auto` resolves to alternate screen on native Windows and WSL, and inline mode elsewhere.
- `--tui-mode` overrides `CODELIA_TUI_MODE`; either can explicitly force `inline` or `alternate`.
- The run row shows the current goal state and a width-limited objective preview. A restored active goal shows `goal resume required`.
- Inline mode renders in the main buffer and inserts overflowed log lines into native terminal scrollback.
- Alternate mode uses the terminal alternate screen, keeps scrolling inside the TUI, and skips native scrollback insertion.
- The run row pulses during startup and execution. It shows a steady `awaiting input` indicator while the runtime waits for a response.
- Image previews use query-free halfblock text cells by default, including tmux. Native Kitty is explicit opt-in (`CODELIA_TUI_IMAGE_PROTOCOL=kitty` with `--tui-mode alternate`), outside multiplexers and with safe OS pixel metrics; unavailable cases show the halfblock fallback reason. Preview graphics are not durable log rows. See [local image preview](tui-image-preview.md) for limits and manual native visual gates.
- With mouse capture enabled in alternate mode, primary drag selects visible
  transcript text and release copies it; wheel scrolling remains available.
- `F2` disables mouse capture when native terminal selection is preferred.
- Inline scrollback sync is driven by `RenderState.sync_phase` (`Idle`/`NeedsInsert`/`InsertedNeedsRedraw`).
- Visible inline log range starts at or after `inserted_until`; already inserted lines are not re-rendered.
- Layout-only viewport changes (confirm/prompt/input height changes) still request an inline sync pass when needed.

## 4. Attachments and Clipboard

- `Alt+V` inserts images or copied files for the next `run.start` or `run.steer`.
- On WSL, native clipboard failure falls back to Windows clipboard via `powershell.exe`.
- Transcript copy prefers the Windows clipboard bridge on WSL. Text is sent as
  UTF-8 through stdin and is never interpolated into PowerShell source.
- Composer renders image tokens as `[Image N]` labels.
- Copied files are staged at paste and uploaded on submission. See [file input and limits](./input-attachments.md).

## 5. Startup and Resume

- CLI baseline options:
  - `codelia --help` / `codelia -h`: prints top-level usage and common TUI passthrough flags.
  - `codelia --version` / `codelia -V` / `codelia -v`: prints CLI version.
  - `codelia-tui --help` / `codelia-tui -h`: prints direct TUI usage and exits.
  - `codelia-tui --version` / `codelia-tui -V` / `codelia-tui -v`: prints version and exits.
  - `--tui-mode <auto|inline|alternate>`: select terminal-buffer behavior; `CODELIA_TUI_MODE` is the lower-precedence environment equivalent.
- Startup initializes runtime capabilities and loads current model/provider.
- Startup log prints a version line (`Version: ...`) after welcome banner.
- With resume mode (`--resume`), TUI fetches session list/history and restores log context.
- With `--initial-message` / `--initial-user-message`, TUI queues and auto-starts first prompt when idle.

## 6. Diagnostics

- `CODELIA_DEBUG=1`: runtime/RPC debug logs.
- `--debug` / `--debug=true`: runtime/RPC debug logs (same effect as `CODELIA_DEBUG=1`).
- `--debug-perf` or `CODELIA_DEBUG_PERF=1`: fixed perf panel (frame/draw/wrap-cache stats).
- `--diagnostics` or `CODELIA_DIAGNOSTICS=1`: enable `run.diagnostics` stream (per-call cache hit/miss, token/latency, final run summary).

## 7. Terminal Colors

- TUI does not query terminal colors with OSC sequences, so delayed color responses cannot leak into composer input.
- Primary canvas text uses the terminal's default foreground/background pair.
- Accents default to a dark-background palette, preserving original theme colors when already bright enough and brightening low-contrast colors. This includes dark gray terminals, rather than optimizing only for pure black/white.
- For a light terminal background, launch with `CODELIA_TUI_COLOR_SCHEME=light codelia`. `dark` is the default; unset or unrecognized values also fall back to dark. The value is read once at startup, case-insensitively, independently of theme hue (`/theme` / `CODELIA_TUI_THEME`). Background colors are not auto-detected.
- Input, code, and diff regions use explicit dark foreground/background pairs, and canvas hierarchy avoids terminal `DIM` styling.
- The bang-shell input prefix keeps a bright dark-surface accent in either color scheme.
