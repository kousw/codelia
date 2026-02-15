# TUI Render State Machine Spec

This document defines a concrete redesign for inline rendering in `crates/tui`.
It addresses the recent failure modes around:

- duplicated lines around confirm open/close
- transient cursor jumps/flicker after scrollback insertion
- fragile parsing of permission preflight text logs

This spec is intentionally concrete so it can be implemented incrementally.

---

## 1. Goals

- Keep inline mode behavior (no alternate screen) while making rendering deterministic.
- Remove ad-hoc flag interactions for scrollback / confirm transitions.
- Separate pure state transitions from terminal side effects.
- Replace string-pattern parsing for permission preflight UI with structured events.

## 2. Non-goals

- Changing the terminal mode policy itself (`inline + scrollback`) from `docs/specs/tui-terminal-mode.md`.
- Replacing Ratatui/crossterm.
- Changing user-visible permission policy logic (allow/deny/confirm decision order).

---

## 3. Problems in Current Approach

1. State explosion
- Multiple booleans (`inline_scrollback_pending`, pending/active confirm, etc.) can produce unexpected interleavings.

2. Unstable scrollback boundary semantics
- In some transitions, already-inserted lines can re-enter viewport rendering.

3. Cursor flicker on side-effect path
- Cursor is affected by scroll-region side effects and then corrected later.

4. Runtime-to-UI coupling via free-form text
- `"Planned ... diff preview"` and `"Permission preflight ready ..."` are parsed from plain text, making behavior wording-dependent.

---

## 4. High-level Architecture

Split a tick into 4 explicit stages.

1. `reduce_inputs` (pure)
- Consume runtime messages + user input.
- Update `AppState` + `RenderState` only.

2. `compute_layout` (pure)
- Compute wrapped metrics and `visible_range`.

3. `draw_frame` (pure from state, except Ratatui draw call)
- Draw from current `RenderState`.

4. `apply_terminal_effects` (side effects)
- Insert scrollback lines.
- Manage terminal cursor visibility/restore.
- Request follow-up redraw if side effects changed terminal-visible state.

No state mutation in stage 4 except dedicated effect result fields.

---

## 5. RenderState Model

Introduce a dedicated state bucket in TUI.

```rust
struct RenderState {
    // Wrapped-log accounting for current width/log_version.
    wrapped_total: usize,

    // Logical viewport on wrapped log.
    visible_start: usize,
    visible_end: usize,

    // Monotonic boundary of lines already inserted to terminal scrollback.
    inserted_until: usize,

    // Synchronization phase for side effects.
    sync_phase: SyncPhase,

    // Confirm display phase to avoid overlap races.
    confirm_phase: ConfirmPhase,

    // Cursor rendering intent.
    cursor_phase: CursorPhase,
}

enum SyncPhase {
    Idle,
    NeedsInsert,
    InsertedNeedsRedraw,
}

enum ConfirmPhase {
    None,
    Pending,
    Active,
}

enum CursorPhase {
    VisibleAtComposer,
    HiddenDuringScrollbackInsert,
}
```

### 5.1 Invariants

Must hold at end of every tick:

- `inserted_until <= visible_start <= visible_end <= wrapped_total`
- `inserted_until` is monotonic unless log is explicitly reset (`clear_log`/session reset).
- `confirm_phase` transition:
  - `Pending -> Active` only after one completed draw and one scrollback sync decision.

Use `debug_assert!` for these invariants in debug builds.

---

## 6. Viewport and Scrollback Rules

1. Viewport lower bound
- `visible_start = max(raw_visible_start, inserted_until)`
- This guarantees lines sent to terminal history are never re-rendered.

2. Scrollback insertion range
- Insert only `[inserted_until, overflow)` where `overflow == visible_start`.
- After successful insertion, `inserted_until = overflow`.

3. Follow-up redraw
- If any lines were inserted this tick, set `sync_phase = InsertedNeedsRedraw` and force exactly one redraw.

4. Clear/reset behavior
- On explicit log reset, reset `inserted_until = 0` and cached wrap metadata.

---

## 7. Confirm Lifecycle

Use explicit phase transitions:

- Runtime confirm request received: `confirm_phase = Pending`
- First post-request frame:
  - preflight lines visible
  - scrollback sync applied if needed
- Next stage transition: `confirm_phase = Active`

While `Pending`, consume key input for main composer as blocked.

This removes accidental modal overlap with just-inserted history lines.

---

## 8. Cursor Control Rules

1. During scrollback insertion side effects
- set `cursor_phase = HiddenDuringScrollbackInsert`
- hide cursor before scroll-region writes

2. After insertion
- do not re-show cursor immediately in side-effect path
- request follow-up redraw

3. Follow-up redraw
- normal `draw_ui` sets cursor position in composer
- terminal draw path restores visible cursor (`VisibleAtComposer`)

4. Initial inline setup
- viewport is anchored to screen bottom on first setup
- cursor snapshot is refreshed after append operation used to allocate viewport space

---

## 9. Runtime ⇄ UI Protocol Extension (Permission Preflight)

### 9.1 Motivation

Preflight preview/ready rendering must not depend on English strings.

### 9.2 New structured event shapes

Add to protocol event union (`packages/protocol` + runtime + TUI parser):

```ts
// Runtime -> UI agent.event.params.event

type PermissionPreviewEvent = {
  type: "permission.preview";
  tool: string;           // "edit" | "write" | ...
  diff?: string;          // unified diff text when available
  summary?: string;       // fallback summary when diff absent
  truncated?: boolean;    // preview shortened
};

type PermissionReadyEvent = {
  type: "permission.ready";
  tool: string;
};
```

### 9.3 Capability negotiation

Add capability bit:

- UI initialize: `ui_capabilities.supports_permission_preflight_events?: boolean`
- Runtime initialize result: `server_capabilities.supports_permission_preflight_events?: boolean`

Behavior:
- If both sides support structured events: runtime emits `permission.preview` / `permission.ready`.
- Otherwise: runtime emits legacy text messages for backward compatibility.

### 9.4 Rendering policy in TUI

- `permission.preview` header is rendered as `LogKind::Status` summary.
- Diff body uses existing rich diff renderer.
- `permission.ready` is rendered as one status summary line (no detail indentation).

---

## 10. Migration Plan

Phase 1 (TUI internal state machine)
- Introduce `RenderState` with invariant checks.
- Keep existing runtime text parsing to avoid protocol lockstep.

Phase 2 (structured preflight protocol)
- Add protocol types and capability flags.
- Runtime emits structured events when supported.
- TUI parser prefers structured events, keeps text fallback temporarily.

Phase 3 (cleanup)
- Remove legacy string pattern parsing after compatibility window.
- Update docs and tests to structured-only path.

---

## 11. Test Plan

### 11.1 Unit tests (TUI parser/render logic)

- preview event -> status header + diff lines
- ready event -> single status summary (no detail indent)
- invariants hold on:
  - confirm request enqueue
  - confirm activation
  - confirm close

### 11.2 State-machine scenario tests

Add deterministic scenario tests (model-level):

1. startup first frame
2. send input -> append logs -> insert scrollback
3. receive confirm preflight preview
4. pending confirm -> active confirm
5. confirm close -> next input cycle

Each step asserts:
- `inserted_until`
- `visible_start/visible_end`
- `sync_phase`
- `confirm_phase`
- `cursor_phase`

### 11.3 Integration smoke

- manual: run TUI in inline mode on common terminals (wezterm, tmux)
- verify no duplicate preview blocks and no visible cursor jump/flicker

---

## 12. Acceptance Criteria

- No duplicated lines around confirm open/close in inline mode.
- No transient visible cursor jump during scrollback insertion.
- Permission preflight rendering works without parsing free-form text when capability is available.
- Legacy runtime text mode remains functional during migration.

