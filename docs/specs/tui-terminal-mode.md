# TUI Terminal Mode Spec (inline + scrollback)

This document defines the terminal-buffer policy for the Rust TUI.

---

## 1. Goals

- Preserve terminal scrollback by default.
- Avoid multiplexer-specific behavior.
- Keep the policy simple (no extra config).

---

## 2. Policy

- **Alternate screen is disabled.**
  - The TUI renders in the main terminal buffer (inline mode).
- **Inline scrollback insertion is enabled.**
  - When the log overflows the visible log area, the scrolled-off lines are
    inserted into the terminal scrollback (so the transcript is visible in the
    terminal history, not just inside the TUI).
- **Mouse capture defaults**
  - Off by default so terminal scrollback works.
  - Users can toggle with `F2` when they want in-TUI mouse wheel scroll.

---

## 3. Behavior summary

- Startup:
  - Use an inline viewport sized to the UI’s desired height.
  - Enter raw mode.
  - Mouse capture is off.
- Runtime:
  - Full-frame layout as today (header, log, input, status).
  - Inline mode draws below the current cursor (previous terminal output remains).
  - When new log lines push the log area past its limit, push those lines into
    the terminal scrollback and keep the viewport anchored near the bottom.
- Exit:
  - Restore raw mode and cursor state.
  - Do not clear the inline viewport; move the cursor to the line after the
    viewport so the shell resumes below the TUI transcript.

---

## 4. Input conventions (unchanged)

- `Enter`: send the message.
- `Shift+Enter`: insert newline when the terminal distinguishes it.
- `Ctrl+J`: newline fallback for terminals that cannot disambiguate `Shift+Enter`.
- `PgUp` / `PgDn`: scroll the in-TUI log.
- `F2`: toggle mouse capture (needed for mouse-wheel scroll inside the TUI).

---

## 5. Trade-offs

- Inline rendering preserves scrollback but relies on terminal scrollback for
  long-term history (the log area remains a window into recent output).
- Mouse-wheel scroll of the terminal is prioritized; in-TUI scroll uses keyboard
  unless mouse capture is explicitly enabled.
