# TUI Inline Scrollback Validation

Status: `Implemented`

This document defines the validation boundary for Codelia's Ratatui inline
viewport and terminal scrollback behavior.

## 1. Ownership boundary

- Ratatui owns inline viewport layout, buffer synchronization, cursor tracking,
  and terminal-specific scrolling-region sequences.
- Codelia selects which wrapped log rows cross the `inserted_until` boundary and
  passes them to `Terminal::insert_before`.
- Codelia advances `inserted_until` only after insertion succeeds and requests a
  follow-up draw so the composer cursor is restored by the normal render path.

Codelia therefore tests the semantic contract at its API boundary instead of
capturing or replaying Ratatui's ANSI output.

## 2. Always-on tests

Focused tests use Ratatui `TestBackend` and run in the normal Rust test suite.
They verify that:

- empty insertion is a no-op;
- history rows enter scrollback when an inline viewport fills the entire terminal;
- the existing viewport remains intact after insertion.

The implementation additionally updates the render-state boundary after each
successful insertion chunk, so an error leaves the failing chunk retryable.

Run:

```bash
cargo test --manifest-path crates/tui/Cargo.toml
```

The full repository entrypoint is:

```bash
bun run test:tui
```

## 3. Manual terminal smoke

Terminal emulators and multiplexers can interpret capabilities differently even
when the semantic backend tests pass. Run a focused manual smoke after changing
Ratatui/crossterm versions, inline viewport construction, history insertion, or
exit cursor placement.

Cover at least:

- a terminal 12 rows high or smaller;
- enough output to overflow the viewport;
- exit back to the shell with the transcript still in terminal history;
- Ghostty directly and, when relevant, tmux or zellij.

## 4. Out of scope

- Codelia-specific assertions about Ratatui's private ANSI sequence choices;
- a full PTY golden capture across terminal emulators;
- multiplexer-specific compatibility guarantees.

Add a PTY integration layer only when it catches a real compatibility class that
cannot be expressed at the Ratatui API boundary.
