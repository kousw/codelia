# Desktop Chat

This document defines the primary conversation experience for the desktop app.

## 1. Goals

- Reach near-TUI parity for single-agent conversations.
- Keep the session transcript as the primary surface of the product.
- Make execution state and supporting context readable without forcing users into the terminal.

## 2. Session model

A session is a workspace-scoped conversation thread with persistent history.

The desktop app should support:

- create session
- resume session
- rename session
- archive session
- delete session
- search or quickly navigate sessions within the current workspace

Branching/forking a session is future work, not a baseline requirement.

## 3. Run lifecycle

The chat surface should expose the runtime run model directly:

- `run.start`
- `run.cancel`
- `agent.event`
- `run.status`
- `run.context`
- optional `run.diagnostics`

Desktop behavior should match runtime/TUI semantics closely:

- one user send creates one run
- cancel is best-effort and idempotent
- terminal `cancelled`, `completed`, and `error` states should end spinners and unblock input

## 4. Transcript rendering

The session transcript should render:

- user messages
- assistant final messages
- intermediate runtime/agent events where useful
- tool execution summaries
- approval/request states
- errors and recovery hints

Reasoning or progress-style events may be collapsible, but should remain inspectable.

Desktop transcript rendering must preserve the real event order.

That means:

- `text -> tool -> text` remains in that order
- tool call and tool result rows are correlated by `tool_call_id`
- compact summaries should not destroy the ability to inspect full output
- final assistant output should not be merged into unrelated progress rows

Verbose tool result bodies may use nested scrolling, but the main chat pane remains the primary scroll container.

## 5. Composer behavior

The composer should support:

- single-line and multiline prompt entry
- send / stop
- IME-safe input handling
- draft preservation while switching panels
- model and reasoning selection near the composer or top bar
- visible attached context chips (file, diff, shell output, selection, image)

The composer remains available even when auxiliary surfaces are hidden.

## 6. TUI parity target

The desktop chat should preserve the user-facing value of current TUI features:

- session resume
- confirm/prompt/pick UI request handling
- model selection
- MCP, skills, and context inspection visibility
- cancellation and run-state visibility

Desktop may differ in layout and discoverability, but not in the underlying execution semantics.

Important parity points:

- session switching does not cancel a running session automatically
- returning to a running session should restore its live state
- background runs belong to their originating session even when another session is visible
- transcript folding/compaction should remain additive, not lossy

## 7. Future-facing requirements

- session search within long transcripts
- turn-level jump links
- better transcript folding for verbose tool output
- checkpoint or turn-restore support if later adopted
- split transcript filters such as `messages only`, `messages + tools`, or `full activity`

## 8. Non-goals

- multi-agent orchestration in a single session
- editor-grade inline code editing inside the transcript
- social/sharing features as a baseline requirement
