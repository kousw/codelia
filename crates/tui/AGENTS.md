# codelia-tui

Rust full-screen TUI client (`crates/tui`) built with Ratatui + crossterm.
The TUI launches runtime, sends UI protocol requests, and renders runtime events.

## Source Of Truth

- Architecture and module boundaries: `docs/specs/tui-architecture.md`
- Render state machine and invariants: `docs/specs/tui-render-state-machine.md`
- Terminal buffer policy (inline mode): `docs/specs/tui-terminal-mode.md`
- User-facing operation summary (commands/keys/startup): `docs/specs/tui-operation-reference.md`
- Runtime/UI RPC contract: `docs/specs/ui-protocol.md`

## Critical Invariants

- Alternate screen is disabled (inline mode + terminal scrollback insertion).
- `RenderState` invariants must hold:
  - `inserted_until <= visible_start <= visible_end <= wrapped_total`
  - `inserted_until` is monotonic except explicit log/session reset.
- Confirm lifecycle is explicit:
  - `confirm_phase`: `Pending -> Active` after one draw/sync decision pass.
- `view/*` must not depend on `handlers/*`.
  - Shared pure logic belongs in `state/*` or `util/*`.
- Permission preflight rendering uses structured events (`permission.preview` / `permission.ready`).
- Legacy text preflight blobs like `Permission request raw args (...)` are intentionally ignored in parser rendering.

## Module Map (Short)

- `src/main.rs`: tick loop, event routing, redraw scheduling.
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
- Basic CLI options are handled in `src/main.rs` (`-h/--help`, `-V/-v/--version`, `--debug`, `--debug-perf`) and exit/enable flags before runtime loop.
- Startup log includes a version line; `CODELIA_CLI_VERSION` (from launcher) is preferred when available.
