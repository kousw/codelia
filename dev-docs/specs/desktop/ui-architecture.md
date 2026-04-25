# Desktop UI Architecture

This document defines the intended UI architecture for the desktop client, with TUI as the behavioral reference for shared execution flows.

## 1. Goals

- Keep runtime/protocol authority centralized.
- Separate product state, UI state, and shell integration cleanly.
- Preserve TUI execution semantics while allowing desktop-specific layout and interaction design.
- Avoid letting ad-hoc view code become the product contract.

## 2. Layer model

The desktop client should be treated as four layers.

### 2.1 Shell layer

Responsibilities:

- native window lifecycle
- menus, dialogs, drag regions, platform integration
- child-process ownership for runtime
- shell-level persistence such as window state

Electrobun is the first implementation target for this layer.

### 2.2 Application orchestration layer

Responsibilities:

- workspace/session selection
- run subscription and live-session routing
- panel open/close state
- routing runtime events into UI-facing state
- coordinating transcript hydration vs live updates

This is the desktop equivalent of the TUI application layer.

### 2.3 View-model/state layer

Responsibilities:

- presentable transcript rows
- workspace/session list state
- panel contents
- composer draft and attachments
- fold/open state for verbose rows

This layer should be deterministic and testable enough to reason about without the shell.

### 2.4 Runtime/protocol layer

Responsibilities:

- JSON-RPC over the runtime bridge
- shared protocol types
- session state persistence
- tool execution / run lifecycle / approvals

Desktop must depend on this layer, not replace it.

## 3. State ownership rules

### 3.1 Runtime-owned

- run lifecycle
- session execution history
- approval and UI-request semantics
- model availability and execution capability
- MCP/skills/context inspection truth

### 3.2 Desktop-owned

- workspace recents
- desktop-specific session metadata such as local title/archive organization
- panel visibility and layout state
- transient view state such as which rows are expanded

### 3.3 Shared but mirrored

Desktop may mirror runtime-owned state for presentation, but the runtime version remains authoritative.

Examples:

- currently selected model
- active run status
- session transcript rows reconstructed from shared history/events

## 4. Session and run routing

Desktop must treat `session` and `run` as separate identities.

Required rules:

- `run_id` maps to a single `session_id`
- session switching must not cancel an unrelated in-flight run
- background runs may continue while another session is visible
- returning to a running session should restore its live stream state rather than forcing a cold transcript reload only
- live event buffers should be keyed per session, not only by “currently visible transcript”
- live runtime events should first enter a run/session-keyed buffer such as `ViewState.liveRuns`; only events whose `run_id` belongs to the selected session may be projected into the visible transcript
- server-originated stream events should carry enough identity for the webview to route them (`run_id`, and when known `session_id` / `workspace_path`)

This is a critical parity point with TUI behavior.

## 5. Transcript projection rules

Desktop view-models should project runtime events into transcript rows using explicit rules:

- preserve event order
- keep assistant text interleaved with tool activity when that is the true sequence
- pair `tool_call` / `tool_result` by `tool_call_id`
- treat permission preview/ready as structured lifecycle state, not raw free-form log lines
- keep verbose bodies collapsible, but never lose inspectability
- when repeated tool activity is obviously repetitive and adjacent, the view-model may group it into a parent row as long as per-item inspectability is preserved
- grouped transcript rows must remain deterministic projections from runtime events; grouping is a presentation rule, not a mutation of the underlying event history
- assistant prose may be rendered with a markdown renderer such as `react-markdown`, but tool/reasoning disclosures should remain structured UI rows rather than being flattened into markdown text
- if markdown is enabled, start with GFM-oriented prose rendering and keep HTML disabled unless a sanitization policy is introduced explicitly
- tool, reasoning, note, and grouped rows should be represented as typed view-model rows and rendered as React elements; do not build transcript UI as HTML strings or rely on `dangerouslySetInnerHTML` for runtime-derived row structure
- capability-gated desktop-only tools may project into richer transcript rows when their tool-result payload is typed and bounded; the first example is `ui_render` projecting to an inline generated panel instead of a generic disclosure row
- the longer-term generated UI path should prefer `semantic payload -> internal mapper workflow -> bounded renderer`, with the desktop transcript projecting the final surface rather than the mapper's intermediate drafts

The rendering approach may differ from TUI, but the logical event ordering must not.

## 6. View-state update policy

Desktop receives high-frequency streaming events, so state updates must stay
slice-oriented and structurally shared.

Required rules:

- do not deep-clone the entire `ViewState` for every event or keystroke
- keep hot streaming updates narrow to the affected run, transcript projection, or status slice
- preserve object identity for unrelated large slices such as transcript history, generated UI payloads, inspect data, and workspace/session lists
- create fresh initial snapshot objects for new view states so mutable live buffers are never shared across sessions or tests
- prefer explicit state action helpers over ad-hoc store mutation from controller code
- add focused regression tests when changing live-run routing, transcript projection, or store update helpers

## 7. Panel architecture

Panels should be optional supporting surfaces, not mandatory permanent regions.

Expected panel classes:

- workspace/session navigation rail
- primary chat surface
- auxiliary surface host for inspect, files, git, terminal, and future tabs

The auxiliary surface should be:

- hideable
- workspace-scoped where practical
- restorable without disturbing the active chat state

## 8. Component and renderer boundaries

Desktop components should remain surface-focused rather than growing into feature
clusters.

Guidance:

- split composer sub-surfaces once they mix input state, command/shell/skill suggestions, branch selection, and model controls
- keep generated UI renderer families in dedicated modules such as `components/generated-ui/*` when a node family grows beyond a compact branch
- keep transcript assembly, scroll synchronization, and render-only rows separated
- prefer small pure helpers for mode-switching, event projection, and eviction predicates so review findings can be covered by focused tests

## 9. Scroll ownership

Desktop should define one clear scroll owner per major region.

Baseline expectations:

- chat pane owns transcript scrolling
- sidebar owns workspace/session list scrolling
- auxiliary panel owns its own internal scroll when open
- the outer app shell should not become the accidental long-page scroller during normal use
- transcript disclosure open/close state belongs to desktop-local transient view state, not runtime session history

## 10. TUI parity baseline

Desktop should explicitly preserve these TUI-side contracts:

- one run per send
- explicit `run.status` transitions
- structured approval/UI-request handling
- tool lifecycle ordering and compaction semantics
- session resume through the same shared storage

Desktop may add richer view state, but should not invent alternative execution semantics.

## 11. Non-goals

- embedding runtime business logic inside the webview
- using desktop-local state as the source of truth for run/session semantics
- permanent panel proliferation without clear ownership of state and scroll behavior
