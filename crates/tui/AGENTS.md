# codelia-tui

Rust full-screen TUI client (`crates/tui`) built with Ratatui + crossterm.
The TUI launches runtime, sends UI protocol requests, and renders runtime events.

## Source Of Truth

- Architecture and module boundaries: `dev-docs/specs/tui-architecture.md`
- Render state machine and invariants: `dev-docs/specs/tui-render-state-machine.md`
- Terminal buffer policy (inline mode): `dev-docs/specs/tui-terminal-mode.md`
- User-facing operation summary (commands/keys/startup): `dev-docs/specs/tui-operation-reference.md`
- Runtime/UI RPC contract: `dev-docs/specs/ui-protocol.md`
- VT100 self-validation strategy/tests: `dev-docs/specs/tui-vt100-self-validation.md`
  - Run opt-in VT100 replay checks when changing inline viewport/scrollback insertion/cursor restore behavior.
  - VT100 replay can be comparatively flaky; use as a targeted terminal-regression check.

## Critical Invariants

- Alternate screen is disabled (inline mode + terminal scrollback insertion).
- Initial inline viewport starts from current cursor row, then shifts downward via overflow insertion until bottom-anchored.
- `RenderState` invariants must hold:
  - `inserted_until <= visible_start <= visible_end <= wrapped_total`
  - `inserted_until` is monotonic except explicit log/session reset.
- Confirm lifecycle is explicit:
  - `confirm_phase`: `Pending -> Active` after one draw/sync decision pass.
- `view/*` must not depend on `handlers/*`.
  - Shared pure logic belongs in `state/*` or `util/*`.
- Permission preflight rendering uses structured events (`permission.preview` / `permission.ready`).
- Legacy text preflight blobs like `Permission request raw args (...)` are intentionally ignored in parser rendering.
- Hosted `web_search` lifecycle is rendered as a compact single-line summary that prioritizes query text (not raw payload body).

## Module Map (Short)

- `src/main.rs`: tick loop, event routing, redraw scheduling.
- `src/entry/`: startup composition (`cli`, `bootstrap`, `terminal`) extracted from main.
- `src/event_loop/`: runtime response/input handlers used by the tick loop.
- `src/app/mod.rs`: app state root (`AppState`) and orchestration helpers.
- `src/app/state/`: input/log/ui/render state buckets.
- `src/app/view/`: Ratatui UI composition.
- `src/app/render/`: terminal-facing side effects (inline history insertion/cursor sync).
- `src/app/handlers/`: key flows and command/panel/confirm handling.
- `src/app/runtime/`: runtime process adapter and protocol parser.
- `src/app/util/`: shared helpers (text, attachments, clipboard).
- Local layer notes are colocated in:
  - `src/app/AGENTS.md`
  - `src/app/state/AGENTS.md`
  - `src/app/view/AGENTS.md`
  - `src/app/render/AGENTS.md`
  - `src/app/handlers/AGENTS.md`

## Development

- Run: `cargo run --manifest-path crates/tui/Cargo.toml`
- Local check: `cargo fmt --manifest-path crates/tui/Cargo.toml`
- Local test: `cargo test --manifest-path crates/tui/Cargo.toml`
- Basic CLI options are handled in `src/entry/cli.rs` and consumed from `src/main.rs` before runtime loop.
- Startup log includes a version line; `CODELIA_CLI_VERSION` (from launcher) is preferred when available.
- Bang shell mode is implemented: legacy runtimes use `shell.exec`, while runtimes advertising `supports_shell_tasks` switch to `shell.start + shell.wait` so the same deferred `<shell_result>` injection path still works.
- Successful terminal shell results keep the detail area output-focused: execution time is appended to the summary, successful results usually surface plain output lines without extra labels, and when shell result details need explicit stream labeling the UI uses human-facing labels such as `Output:` / `Stderr:` instead of raw stream names.
- When a pending `Shell: ...` tool-call line completes, TUI replaces that line with the final shell summary (`✔ Shell: <command> (N ms)`) instead of merely prefixing a status icon.
- `shell.wait` may return `still_running: true` after its bounded wait window expires; TUI should surface that as status and leave the task running rather than enqueueing a deferred shell result.
- While an attached shell wait is active and the runtime advertises `supports_shell_detach`, `Ctrl+B` issues `shell.detach { task_id }` and leaves the shell task running in background.
- `/tasks` now uses the public `task.*` RPC surface for list/show/cancel over retained task metadata.
- `/model` persists the selected model with `model.set scope=config`; `/model --session` and `/model-session` use `scope=session` for the active runtime/session only, and `/model-session reset` clears the override. Status renders session-scoped models as `model~:`.
- `/fast [on|off|toggle]` updates the current model via `model.set` with the `fast` flag; the runtime gates actual provider fast mode by model support. Status renders enabled fast mode with `⚡`.
- `/tasks` list/show/cancel surfaces a shell task's public `key` first (for example `build-xxxxxxxx`), while still showing the underlying `task_id` because the current command surface still accepts `task_id` arguments.
- Agent shell tool rendering keeps `shell_list` user-facing output compact: `ShellList: ...` summary plus one muted line per task (`state | key | optional label | command`) instead of dumping the raw JSON payload.
- Prompt submissions while a run is active are queued locally (FIFO) and auto-dispatched when run/pending/dialog gates are clear.
  - Queue command surface: `/queue`, `/queue cancel [id|index]`, `/queue clear`.
  - Queued items snapshot the final `run.start` input payload (including image parts and deferred shell-result prefix) at enqueue time.
  - After a terminal `run.status` (`completed`/`error`/`cancelled`), queued prompt dispatch waits one retry-backoff interval before resending to avoid racing runtime teardown and transient `runtime busy`.
- `--debug-perf` now includes a best-effort RSS memory line for both the TUI process and the runtime child.
  - Linux uses `/proc/<pid>/status`.
  - macOS uses `libc::proc_pid_rusage` (no `ps` shell-out in the UI loop).
  - Windows uses Win32 process APIs (`OpenProcess` + `K32GetProcessMemoryInfo`).
  - Other unsupported platforms may still show `-`.
- TUI session resume/history requests cap `session.history.max_events` to `500` to keep inline restore volume closer to typical terminal scrollback sizes.
- Resume picker starts in current-worktree scope and `A` toggles between current workspace and all saved sessions.
- When `session.history` returns `resume_diff`, TUI renders those status lines immediately after `History restored ...`; runtime only includes it for material current-vs-saved resume-context changes, so legacy/no-change restores stay quiet.
