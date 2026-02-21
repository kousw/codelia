# TUI Wrap Indent Continuation

Status: `Planned`

This spec defines a phased implementation to preserve logical indentation when long TUI lines wrap, while keeping viewport and scrollback behavior consistent across insertion boundaries.

## 1. Goal

When a long line wraps, continuation rows should retain structural context instead of restarting from column 0.

Representative cases:

- `- item ...` continues under item text.
- `1. item ...` continues with ordered-list alignment.
- `> quote ...` keeps quote context on continuation rows.
- Indented code/log lines preserve indentation depth.

## 2. Non-goals

- Full markdown reflow/re-parse on every terminal resize.
- Rewriting scrollback rows already emitted into the terminal backbuffer.
- Making phase-1 behavior perfectly identical across all terminal emulators.

## 3. Why this is hard

Continuation indent affects three coupled paths:

1. Viewport wrapping in the ratatui render path.
2. Scrollback insertion wrapping used for terminal backbuffer writes.
3. Boundary bookkeeping (`inserted_until`, `visible_start`) under streaming + resize.

Changing only one path can create visual discontinuities around boundaries.

## 4. Phased implementation

### Phase 1: Continuation indent in ratatui viewport (render path only)

Scope:

- Add continuation-indent-aware wrap in the viewport rendering path.
- Apply it first to the non-inserted viewport region to reduce risk near the insertion boundary.

Expected result:

- Immediate readability gain for currently visible content.
- Temporary mismatch near the inserted boundary is acceptable for this phase.

### Phase 2: Align wrap rules in scrollback insertion path

Scope:

- Apply the same continuation wrap policy to `insert_history_lines` input segmentation.
- Keep wrap decisions equivalent between viewport and insertion paths for the same width.

Expected result:

- Consistent appearance before/after rows cross `inserted_until`.
- Reduced boundary jumps and fewer perceived duplicates/missing rows.

### Phase 3: Validation hardening (unit + VT100 replay)

Scope:

- Add/extend deterministic unit tests for continuation prefix detection and wrapping.
- Add VT100 replay cases that cover boundary transitions, resize during streaming, and cursor stability.

Expected result:

- Better regression resistance for wrap/resize/boundary interactions.

## 5. Boundary and resize cautions

`inserted_until` and resize handling are critical:

- Keep `inserted_until` monotonic; width changes must not move it backward.
- Treat width changes as a re-derivation of wrapping, not as a rewrite of already-inserted backbuffer rows.
- Avoid mixing old-width and new-width wrap counts in a single boundary window.
- Ensure `visible_start`/cursor math uses the same wrapped-row model as rendering.

## 6. Shared logic guidance

Use one shared wrapping policy/helper for both paths:

- Prefix detection: unordered/ordered list markers, quote prefixes, leading indentation.
- Continuation prefix generation based on detected prefix.
- Width-aware segmentation using existing Unicode width utilities.
- Span safety: preserve style/token boundaries when inserting continuation prefixes.

## 7. Failure modes and guardrails

Potential regressions:

- Boundary duplicates.
- Apparent missing rows after resize.
- Cursor jumps caused by wrap-count mismatch.

Guardrails:

- Monotonic boundary updates.
- Best-effort stability during live streaming + resize.
- Replay-based checks for terminal/backbuffer-specific regressions.

## 8. Rollout

1. Phase 1 in viewport path.
2. Phase 2 parity update for insertion path.
3. Phase 3 test/replay expansion.

## 9. Related docs

- `docs/specs/tui-render-state-machine.md`
- `docs/specs/tui-terminal-mode.md`
- `docs/specs/tui-vt100-self-validation.md`
- `docs/specs/backlog.md` (B-028)
