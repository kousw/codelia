# Desktop Built-In Terminal

This document defines the built-in terminal surface that complements the session workflow.

## 1. Goals

- Give users a first-class shell pane inside the desktop app.
- Keep shell actions close to the active workspace and session.
- Preserve room for a real terminal implementation later without overcommitting the product spec to one library.

## 2. Product-level terminal model

The desktop app has a built-in `Terminal` auxiliary surface bound to the selected workspace.

The terminal surface should provide:

- current workspace cwd awareness
- interactive shell session
- command execution visibility
- stdout/stderr readability
- exit code/status visibility
- rerun/cancel actions where supported

The terminal is part of the product, not just a debug-only fallback.

## 3. Session integration

Users should be able to:

- send shell output to the current session as context
- reference the current shell working directory in session context
- jump from shell errors to follow-up chat requests naturally

The session should not need to re-explain where shell output came from.

## 4. Terminal interaction expectations

The built-in terminal should behave like a support surface, not a second primary app.

Preferred baseline:

- hidden by default
- reopenable from a stable top-bar or auxiliary-panel affordance
- workspace-scoped current directory
- scrollback that remains inside the terminal surface
- clear distinction from inline shell execution inside chat

## 5. Implementation direction

This spec stays implementation-agnostic at the product layer.
For the first desktop implementation, `libghostty` is the preferred integration direction if it fits the chosen shell container.

That means:

- product behavior should not depend on a specific terminal library API
- shell UX should still describe interactive-terminal expectations rather than only one-shot command results

## 6. Compatibility with runtime shell surfaces

The desktop app may use runtime shell/task RPCs for workflow integration where useful:

- `shell.exec`
- `shell.start` / `shell.wait` / related shell task methods
- `task.*`

However, the embedded shell pane and runtime task APIs are separate concepts:

- embedded shell pane: user-driven terminal workspace
- runtime shell/task RPCs: execution surfaces tied to agent/runtime workflows

Both may coexist in the product.

## 7. Deferred terminal features

- multiple terminal tabs
- detached jobs
- persistent task monitor
- advanced terminal search/history features

## 8. Non-goals

- replacing a dedicated power-user terminal emulator
- requiring terminal embedding to ship before desktop can exist at all
