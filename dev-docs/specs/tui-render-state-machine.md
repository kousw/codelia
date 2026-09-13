# TUI Render State Machine Spec

This document defines the render-state contract for inline rendering in
`crates/tui`. Alternate mode reuses the application/log state but skips the
inline `Terminal::insert_before` side-effect path; startup mode selection is
defined separately in `tui-terminal-mode.md`.
It addresses the recent failure modes around:

- duplicated lines around confirm open/close
- transient cursor jumps/flicker after scrollback insertion
- fragile parsing of permission preflight text logs

This spec is intentionally concrete so it can be implemented incrementally.
Module boundary and responsibility diagram is maintained in `dev-docs/specs/tui-architecture.md`.

---

## 1. Goals

- Keep inline mode's native-scrollback rendering deterministic.
- Remove ad-hoc flag interactions for scrollback / confirm transitions.
- Separate pure state transitions from terminal side effects.
- Replace string-pattern parsing for permission preflight UI with structured events.

## 2. Non-goals

- Changing the startup terminal-mode selection policy from `dev-docs/specs/tui-terminal-mode.md`.
- Changing user-visible permission policy logic (allow/deny/confirm decision order).

---

## 3. Problems in Current Approach

1. State explosion
- Multiple booleans (`inline_scrollback_pending`, pending/active confirm, etc.) can produce unexpected interleavings.

2. Unstable scrollback boundary semantics
- In some transitions, already-inserted lines can re-enter viewport rendering.

3. Cursor flicker on side-effect path
- Cursor is hidden during history insertion and restored by the required follow-up draw.

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

    // Source progress independent of wrapping (log index + grapheme offset).
    committed: LogPosition,

    // Projection of committed into the current wrapped generation.
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
- `committed` advances only after successful insertion chunks. `inserted_until` is derived from wrapped row source positions; it may decrease on width or historical-log changes without replaying content.
- Wrapping preserves a break at a partially committed source position, so a wider row cannot combine already-inserted text with its uninserted suffix. Offsets count source graphemes, excluding synthetic indentation and padding.
- `confirm_phase` transition:
  - `Pending -> Active` only after one completed draw and one scrollback sync decision.

Use `debug_assert!` for these invariants in debug builds.

---

## 6. Viewport and Scrollback Rules

1. Viewport lower bound
- `visible_start = max(raw_visible_start, inserted_until)`
- Before computing the visible range, project `committed` into the current wrap cache by counting rows whose `source_end <= committed`.
- This excludes unchanged source content already sent to terminal history, even after rewrapping.

2. Scrollback insertion range
- Insert only `[inserted_until, overflow)` where `overflow == visible_start`.
- After each successful chunk, advance `committed` to the last inserted row's source end and advance `inserted_until` within the drawn generation. Do not rebuild the wrap cache in the side-effect path.
- If layout was skipped (for example a very short terminal) and no valid drawn cache is available, defer insertion without advancing progress.
- Stop at the first row wider than the viewport, including generated prefixes/padding. Do not commit clipped source content; widening allows it to be retried.

3. Follow-up redraw
- If any lines were inserted this tick, set `sync_phase = InsertedNeedsRedraw` and force exactly one redraw.
- Restore the viewport immediately in the same tick, before the next input poll. The LF-based Ratatui insertion path clears the viewport; leaving the redraw until the next tick causes a visible blank interval.
- `render/frame.rs::draw_frame` bounds a cycle to one insertion pass and two draws. If the restoring draw introduces overflow through a resize/layout change, leave it in `NeedsInsert` and schedule another cycle. Do not insert again after the final restoring draw or loop until the terminal stops resizing.

4. Clear/reset behavior
- On explicit log reset, reset both `committed` and `inserted_until` to zero and clear cached wrap metadata.

5. Historical replacements
- Replacing a fully committed logical line does not move the source boundary or rewrite native terminal history. Its current version remains in the in-memory log for alternate rendering/replay.
- When replacing the partially committed line, retain the source offset if its committed text prefix is unchanged. If only the pending suffix is removed, normalize progress to the next logical line.
- If that committed prefix changes, replay the revised partial line from its start rather than skipping new text. This is an explicit revision, not a resize-induced duplicate.
- The log currently supports append/replace/clear. Any future structural insertion/removal must remap source positions.

6. Large histories
- Clamp wrapped row counts to the available height in `usize` before converting to `u16`, in both desired-height calculation and drawing.

7. Native scrollback compatibility
- Keep Ratatui's `scrolling-regions` feature disabled. Its CSI S scroll-up operations remove rows without retaining them in xterm.js native history; successful TestBackend insertion does not prove real scrollback retention.
- Use Ratatui's standard LF-based insertion path. Keep `inline` mode and source-position accounting unchanged rather than forcing alternate screen or inferring a host application from environment strings.
- Wide-glyph continuation symbols are emptied only in the disposable insertion buffer. Codelia and Ratatui must use the same `unicode-width` semantics; differing versions can erase real following cells. Host Unicode-width conventions remain a separate compatibility limit.
- See `tui-inline-scrollback-validation.md` for the real-Crossterm/headless-emulator replay check.

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
- hide cursor before calling Ratatui `Terminal::insert_before`

2. After insertion
- do not re-show cursor immediately in side-effect path
- request follow-up redraw

3. Follow-up redraw
- normal `draw_ui` sets cursor position in composer
- terminal draw path restores visible cursor (`VisibleAtComposer`)

4. Initial inline setup
- construct Ratatui `Viewport::Inline` from the current cursor position and the
  UI's desired initial height
- let Ratatui own viewport resize and buffer synchronization during later draws

5. Ownership boundary
- use `Terminal::insert_before` for runtime history insertion so Ratatui updates
  its viewport, cursor, and buffers consistently
- direct backend mutation is reserved for final cursor placement after the event
  loop has ended; it must not be introduced into normal draw/effect processing

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
