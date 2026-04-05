# Desktop Context And Runtime Surfaces

This document defines the runtime-adjacent surfaces that the desktop UI must expose.

## 1. Goals

- Keep runtime behavior visible and explainable.
- Let supporting panels feed context back into the current session.
- Reuse existing protocol surfaces whenever possible.

## 2. Runtime connection model

The desktop shell launches and owns a local `@codelia/runtime` child process and communicates over stdio NDJSON JSON-RPC.

The UI must surface:

- runtime connected/disconnected state
- initialize success/failure
- capability availability
- recoverable reconnect/restart actions

## 3. UI request handling

Desktop must support runtime-driven UI requests:

- `ui.confirm.request`
- `ui.prompt.request`
- `ui.pick.request`

Requirements:

- requests block the relevant run until answered
- the request origin should remain visible in the transcript
- cancellation/close behavior should map cleanly to runtime expectations

## 4. Context surfaces

Desktop should be able to send workspace-scoped context using `ui.context.update`, including:

- cwd
- workspace root
- active file
- current selection
- selected text when immediately available

The current session should make attached context visible before send.

## 5. Inspection and status panels

Desktop should expose the following protocol-backed surfaces:

- `model.list` / `model.set`
- `mcp.list`
- `skills.list`
- `context.inspect`
- `session.list` / `session.history`

These may appear as dialogs, side panels, or inline controls as long as they remain easy to discover.

## 6. Diagnostics and approvals

Desktop should allow opt-in diagnostics visibility for:

- per-call usage/cost/latency
- final run summary

Approval/permission-related state should be rendered in a more readable form than raw event text when possible.

## 7. Future protocol additions

Desktop may need protocol additions for richer workspace surfaces.
The expected next family is:

- `workspace.tree`
- `workspace.read`
- `workspace.diff`
- `ui.render` / generated structured UI surface events

Today, desktop generated UI ships as a capability-gated desktop-only
`ui_render` tool whose typed `tool_result` payload is rendered inline by the
desktop client. A future `ui.render` family should only be added when the
typed tool-result path stops being a clean enough fit for richer surfaces,
actions, or persistence needs.

The preferred longer-term generated UI path is:

- main agent emits a semantic structured payload
- runtime runs an internal ephemeral mapper workflow
- desktop renders only the final bounded UI spec

That mapper workflow should stay private to runtime rather than becoming part of
the public session/transcript contract by default.

## 8. Non-goals

- moving sandbox or permission policy into the desktop shell
- custom runtime behavior that diverges from other clients without an explicit spec
