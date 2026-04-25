# Desktop Inline Shell Execution

This document defines shell execution as it appears inside the chat workflow, distinct from the built-in terminal pane.

## 1. Goals

- Make runtime-driven shell execution understandable inside the transcript.
- Preserve TUI shell/task semantics while improving discoverability and inspectability.
- Keep agent shell activity distinct from a user-controlled embedded terminal.

## 2. Product model

Inline shell execution is the transcript-facing representation of runtime shell/task tools such as:

- `shell.exec`
- `shell.start`
- `shell.wait`
- `shell.logs`
- `shell.result`
- `shell.cancel`

This is an agent/workflow surface, not the same thing as a built-in terminal tab.

## 3. Transcript rendering requirements

Inline shell rows should:

- appear in true event order with assistant text
- show a compact call summary
- surface running/completed/error state clearly
- keep long output inspectable without flooding the main transcript
- allow copying output reliably

The baseline compact summary should resemble the TUI mental model:

- command-oriented summary for call
- final output/result summary for completion
- expandable body for longer logs or output

## 4. Interaction model

Users should be able to:

- expand/collapse long output
- copy command/output
- send selected output back into the prompt as context
- understand whether a shell step is still running in the background

Inline shell output should never look identical to final assistant prose.

The desktop composer also supports TUI-style bang shell execution. When a user submits `!command`, desktop should execute the command via runtime `shell.exec`, keep the result queued locally, and inject it into the next ordinary prompt as a deferred `<shell_result>` block rather than sending a model run immediately.

## 5. Relationship to built-in terminal

Built-in terminal:

- user-driven
- persistent shell environment
- workspace support surface

Inline shell execution:

- agent-driven
- run-scoped
- part of transcript/history

Both should coexist without being conflated.

## 6. Background execution rules

If a run continues while another session is visible:

- the shell task continues in the background
- its eventual state remains attached to the originating session
- returning to that session should restore the correct shell lifecycle rows

Desktop must not imply that session switching cancelled the underlying shell task.

## 7. TUI parity baseline

Desktop should preserve the user-facing meaning of TUI shell rows:

- compact summaries instead of raw metadata dumps
- clear failed/cancelled distinction
- output-first details where possible
- no silent loss of stdout/stderr visibility

## 8. Non-goals

- replacing the built-in terminal with transcript shell rows
- showing every shell metadata field inline by default
