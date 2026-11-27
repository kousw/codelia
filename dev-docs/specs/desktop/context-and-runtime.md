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

## 6. Telemetry, diagnostics, and approvals

Runtime always emits `run.metrics` (per completed LLM call) and `run.summary`
(per run + session cumulative totals), and exposes the read-only `telemetry.get`
pull RPC behind `supports_telemetry`. Desktop should subscribe to these always-on
notifications and call `telemetry.get` on connect / panel open to render:

- live per-call TPS, TTFT, latency, cache hit/ratio, token usage, and metered API list cost
- session-cumulative totals surviving agent invalidation
- recent tool timings (splitting `exec_duration_ms` vs `approval_wait_ms`) and compaction metrics
- runtime perf snapshot (startup/agent-init phases, memory, active subagents, transport backpressure)

Approval/permission-related state should be rendered in a more readable form than raw event text when possible.

### Workspace sandbox menu

After `initialize` advertises `supports_sandbox_mode_management`, the desktop calls `sandbox.get`. The workspace chip shows the sandbox selected for the next run. If an agent already exists, the runtime also reports its actual mode. The menu uses the mode IDs, labels and descriptions supplied by the runtime. `workspace-write` is the successor to `trusted`. `full-access` means OS isolation is disabled for approved commands.

The desktop checks the initialization capability before offering edits. A workspace selection calls `sandbox.set` with `scope: "project"` and the selected mode ID. When a CLI flag or environment variable fixes the choice, the chip stays visible, names the source and disables the menu. A runtime that cannot verify the Windows policy file’s ACL returns a distinct read-only reason. While work is running, the UI can show the active agent’s mode and why switching is unavailable. After an accepted change, the desktop renders the state returned by the server. A concurrent run or a locked setting returns an error and the desktop refreshes the chip.

The first menu changes this workspace. Auto approve uses the separate approval controls and the registered review models. [Local execution design](../command-approval-and-auto-review.md) · [Wire contract](../ui-protocol.md#workspace-sandbox-rpc)

## 7. Future protocol additions

Desktop may need protocol additions for richer workspace surfaces.
The expected next family is:

- `workspace.tree`
- `workspace.read`
- `workspace.diff`

These should be added only when the corresponding desktop surface cannot be implemented cleanly with existing flows.

## 8. Non-goals

- moving sandbox or permission policy into the desktop shell
- custom runtime behavior that diverges from other clients without an explicit spec
