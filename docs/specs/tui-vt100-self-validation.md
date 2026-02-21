# TUI VT100 Self-Validation

Status: `Implemented (phase 1)`

This document defines a two-level validation strategy so `codelia-tui` can self-check
its inline terminal behavior without relying only on manual testing.

## 1. Goals

- Catch regressions in inline scrollback/cursor contract early.
- Keep a fast, deterministic validation path in normal `cargo test`.
- Provide a VT100 semantic replay path for higher confidence checks.

## 2. Level 1: Deterministic backend contract tests (always on)

Scope:

- `compute_inline_area` startup anchoring/cursor snapshot behavior.
- `insert_history_lines` side effects on:
  - viewport shift
  - cursor restore
  - emitted escape control sequences

Method:

- Use a small mock backend implementing `ratatui::backend::Backend + Write`.
- Capture emitted ANSI bytes directly from `Write`.
- Assert structural contract (e.g. scroll-region sequences and reverse-index usage).

Execution:

- Runs in regular unit test pass: `cargo test --manifest-path crates/tui/Cargo.toml`.

## 3. Level 2: VT100 replay validation (opt-in)

Scope:

- Validate the *semantic* effects of emitted ANSI by replaying into a VT100 parser.
- Confirm cursor position and visible content after inline history insertion sequence.

Method:

- Reuse the same mock backend output stream.
- Feed captured bytes into `vt100::Parser`.
- Assert cursor row/column and terminal content expectations.

Execution:

- Test is gated by env var `CODELIA_TUI_VT100_REPLAY=1`.
- Default run skips this heavier path to avoid CI/runtime instability.

Command example:

```bash
CODELIA_TUI_VT100_REPLAY=1 cargo test --manifest-path crates/tui/Cargo.toml vt100
```

## 4. Out of scope (for now)

- Full PTY process orchestration with runtime child and interactive key stream.
- Multiplexer-specific rendering variance (`tmux` / `zellij`) golden capture.

These can be added as a later phase after replay-level checks stabilize.
