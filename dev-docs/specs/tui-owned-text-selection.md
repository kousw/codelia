# TUI-owned Text Selection and Copy

Status: `Partial`

This document defines the target contract for application-owned transcript text
selection in Codelia's Rust TUI. The initial implementation target is
alternate-screen mode, where Codelia captures mouse events for internal
scrolling and native terminal drag selection is therefore unavailable without a
terminal-specific modifier.

Phase 1 is implemented: alternate-mode visible-transcript drag selection,
highlighting, native/WSL copy-on-release, stale-projection cancellation, and
transient copy feedback. Phase 2 OSC 52 fallback and drag auto-scroll, plus the
phase 3 affordances, remain proposed.

---

## 1. Decision summary

Codelia keeps mouse capture enabled by default in alternate mode and provides a
TUI-owned selection path for the transcript viewport.

The target interaction is:

1. unmodified primary-button drag selects transcript text inside Codelia;
2. the selected cells are highlighted by the TUI;
3. releasing after a non-empty drag copies the corresponding text;
4. wheel scrolling remains available because mouse capture stays enabled; and
5. `F2` and terminal-native modifier selection remain escape hatches.

This is an application selection model, not an attempt to make the terminal's
native selection work while mouse reporting is active.

---

## 2. Problem and current behavior

The implemented alternate-screen path now:

- enters the alternate screen;
- enables crossterm mouse capture by default;
- routes `ScrollUp` and `ScrollDown` to Codelia's transcript scroll state;
- routes full primary-button events through the frame hit map;
- highlights a visible transcript selection; and
- copies a non-empty selection on release through native or WSL clipboard
  adapters.

On Windows Terminal/WSL, mouse reporting sends an unmodified drag to Codelia
instead of the terminal's native selection layer. Codelia now owns that gesture
inside the visible transcript. `Shift+drag` or `F2` remain native-selection
escape hatches.

Bracketed text paste is a separate path and remains implemented through
`Event::Paste`. This specification must not regress `Ctrl+Shift+V` or other
terminal paste bindings. Windows-style right-click paste is a follow-up in this
specification, not part of the first selection milestone.

---

## 3. Goals

- Make ordinary drag-to-select and copy work in alternate mode while preserving
  Codelia's internal wheel scrolling.
- Copy the logical visible transcript text, not ANSI/style data or painted
  padding.
- Preserve Unicode grapheme boundaries and terminal cell-width behavior.
- Preserve hard line breaks while removing soft-wrap-only breaks.
- Keep selection state and text projection testable without a real terminal.
- Make WSL copy target the Windows clipboard through a bounded, injection-safe
  bridge when native clipboard access is unavailable.
- Keep renderer, state, event, and clipboard responsibilities separated by the
  existing TUI architecture.
- Fail without crashing or mutating the composer when clipboard access is
  unavailable.

## 4. Non-goals

- Replacing native terminal selection in inline mode.
- Selecting composer, status, debug, picker, or confirmation-dialog content in
  the first implementation.
- Rich semantic copy of hidden tool data, raw Markdown, or runtime protocol
  payloads. Copy is based only on the rendered transcript projection.
- Rectangular/block selection.
- Keyboard-driven copy mode, transcript search, or a `/copy` command.
- Dragging across multiple independent panels.
- Changing the `auto | inline | alternate` resolution policy.
- Treating an unconfirmed OSC 52 write as guaranteed clipboard success.

---

## 5. Reference implementations

### 5.1 Pi

Pi's fullscreen renderer enables mouse reporting and owns transcript selection.
It tracks the selection anchor/focus, supports drag auto-scroll, styles the
selected cells, reconstructs selected text, and copies on button release. The
host application injects a native clipboard callback, with OSC 52 as the
renderer fallback.

Inspected 2026-08-17 at `badlogic/pi-mono`
`d3ab2af969d64997338253c9151190aa1bc33580`:

- [`packages/tui/src/tui-alt-screen.ts`](https://github.com/badlogic/pi-mono/blob/d3ab2af969d64997338253c9151190aa1bc33580/packages/tui/src/tui-alt-screen.ts)
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](https://github.com/badlogic/pi-mono/blob/d3ab2af969d64997338253c9151190aa1bc33580/packages/coding-agent/src/modes/interactive/interactive-mode.ts)
- [`packages/coding-agent/src/core/settings-manager.ts`](https://github.com/badlogic/pi-mono/blob/d3ab2af969d64997338253c9151190aa1bc33580/packages/coding-agent/src/core/settings-manager.ts)

Codelia adopts the application-owned selection boundary. Codelia must not copy
Pi's rendered-line trimming approach directly because its wrapped `LogLine`
values contain synthetic user-bubble and painted-background padding that needs
explicit provenance.

### 5.2 OpenCode

OpenCode's OpenTUI renderer owns mouse selection and calls clipboard copy from
the selection lifecycle. Its clipboard path combines OSC 52 with platform
clipboard adapters, including PowerShell on Windows.

Inspected 2026-08-17 at `anomalyco/opencode`
`a0f8dccbfe139ffc7137d1eaf6fee6e4195af599`:

- [`packages/tui/src/index.tsx`](https://github.com/anomalyco/opencode/blob/a0f8dccbfe139ffc7137d1eaf6fee6e4195af599/packages/tui/src/index.tsx)
- [`packages/tui/src/clipboard.ts`](https://github.com/anomalyco/opencode/blob/a0f8dccbfe139ffc7137d1eaf6fee6e4195af599/packages/tui/src/clipboard.ts)
- [`packages/tui/src/util/selection.ts`](https://github.com/anomalyco/opencode/blob/a0f8dccbfe139ffc7137d1eaf6fee6e4195af599/packages/tui/src/util/selection.ts)

Codelia adopts explicit host clipboard adapters and copy-on-release. It does not
initially adopt OpenCode's configurable copy-on-select modes or whole-application
selection surface.

---

## 6. User interaction contract

### 6.1 Availability

Owned selection is active only when all of the following are true:

- the resolved terminal mode is `Alternate`;
- mouse capture is enabled;
- the most recently drawn frame has a current transcript hit map; and
- no modal confirmation, prompt, picker, or list panel owns interaction.

Inline mode continues to default mouse capture off and relies on native terminal
selection. Enabling mouse capture manually with `F2` in inline mode does not
enable owned selection in the first implementation.

### 6.2 Primary-button gestures

- An unmodified primary down inside the selectable log area starts a selection
  and clears any previous selection.
- Primary down with `Shift`, `Alt`, or `Control` does not start owned selection;
  if modifiers appear after an owned drag starts, the drag is cancelled without
  copying so one gesture cannot switch ownership mid-stream.
- Primary drag updates the focus point and redraws the highlight.
- Primary up after a non-empty drag ends the drag and attempts to copy.
- Primary up without movement clears the zero-width selection and does not touch
  the clipboard.
- Starting outside the log area does not create a selection.
- While a selection drag is active, coordinates outside the horizontal bounds
  clamp to the nearest selectable edge.
- A later primary down starts a new selection.
- `Esc` clears a completed selection when no higher-priority modal/input action
  consumes it.

Double-click word selection and triple-click logical-line selection are phase 3.

### 6.3 Selection persistence and feedback

After successful copy, the highlight remains until the next primary down,
explicit clear, incompatible state change, or log projection invalidation. This
makes the copied range visible and matches ordinary terminal-selection feedback.

Copy feedback is transient and must not become transcript history:

- confirmed native/Windows bridge success: `Copied N chars`;
- OSC 52 request with no confirmation: `Copy requested (OSC 52)`;
- failure: `Copy failed: <short reason>`.

The notice is shown ahead of both info-mode and help-mode status content. It
expires automatically and must not include copied text.

### 6.4 Existing escape hatches

- `F2` still toggles mouse capture.
- When mouse capture is off, Windows Terminal native drag selection works.
- Terminal-provided modifier selection such as Windows Terminal `Shift+drag`
  remains outside Codelia's control and must not be blocked intentionally.

---

## 7. State model

Selection state belongs under `crates/tui/src/app/state/` and remains
side-effect free.

```rust
enum TextSelectionPhase {
    Idle,
    Dragging {
        anchor: SelectionPoint,
        focus: SelectionPoint,
        projection: SelectionProjectionId,
    },
    Selected {
        anchor: SelectionPoint,
        focus: SelectionPoint,
        projection: SelectionProjectionId,
    },
}

struct SelectionPoint {
    wrapped_row: usize, // absolute index in the wrapped-log projection
    cell: usize,        // zero-based terminal cell within that rendered row
}

struct SelectionProjectionId {
    log_version: u64,
    wrap_width: usize,
}
```

`SelectionProjectionId` identifies the wrapped transcript content, not an
individual draw. A selection-highlight redraw does not change either field and
therefore cannot invalidate an active drag by itself.

The state owns ordering and transition helpers:

- normalize forward/reverse drags;
- reject points from different projections;
- identify zero-width selections;
- clear on invalidation; and
- expose the normalized range to view/copy projection code.

It does not write the clipboard, inspect terminal environment variables, or
emit terminal escape sequences.

### 7.1 Invariants

- `Dragging` and `Selected` endpoints always refer to the same projection ID.
- Endpoints always refer to selectable wrapped rows in that projection.
- A zero-width range is never copied.
- Clipboard writes occur only on the `Dragging -> Selected` transition caused
  by primary-button release.
- Mouse move/drag events never access the clipboard.
- Clearing a selection is idempotent.

---

## 8. Frame geometry and stale-frame contract

Mouse coordinates describe the last terminal frame, not arbitrary current
`AppState`. The draw path therefore publishes a frame-local hit map after it has
computed layout:

```rust
struct TranscriptHitMap {
    frame_revision: u64, // per-draw sequence; not part of selection identity
    projection: SelectionProjectionId,
    log_area: Rect,
    visible_start: usize,
    visible_end: usize,
}
```

Coordinate conversion is:

```text
wrapped_row = visible_start + (mouse_row - log_area.y)
cell        = mouse_column - log_area.x
```

Requirements:

- The hit map is produced from the same layout and wrapped cache used for that
  draw.
- `point_at()` resolves geometry through that cache's selectable fragments:
  empty-row starts are rejected, synthetic horizontal cells clamp to a nearest
  selectable cell, and active drags resolve blank rows in anchor-relative drag
  direction.
- `frame_revision` may advance on every draw. It is diagnostic/current-frame
  metadata only and must never be compared with the projection stored in
  `Dragging` or `Selected`.
- A highlight-only redraw keeps the same `SelectionProjectionId`; the next drag
  event continues against the newly published hit map.
- Viewport scrolling or another non-invalidating redraw that preserves
  `log_version` and `wrap_width` may publish a new hit map without invalidating
  absolute wrapped-row endpoints. Subsequent coordinates use the newest
  `log_area` and visible range. This does not override the explicit resize and
  modal/layout invalidation rules below.
- The event loop passes the full `MouseEvent`, not only `MouseEventKind`.
- A primary down is ignored when the frame is already dirty and awaiting a draw.
- Any mouse event received while the frame is dirty is not mapped through the
  stale hit map. An active drag is retained until the current frame is drawn,
  unless the pending change is itself an invalidation condition.
- A content-projection mismatch (`log_version` or `wrap_width`) during an active
  drag cancels the selection rather than copying from stale coordinates.
- Resize invalidates the hit map and active selection before the next draw.
- Opening/closing a modal or changing transcript/input layout invalidates the
  hit map before another mouse selection can start.

The event loop already knows whether a redraw is pending. Selection routing
must use that fact rather than inventing a second approximate layout epoch.

---

## 9. Provenance-bearing wrapped rows

### 9.1 Why `LogLine::plain_text()` is insufficient

The current wrapped cache stores only rendered `LogLine` rows. Those rows may
contain cells that were never part of the source transcript text:

- full-width background padding on code and diff rows;
- user-message bubble leading/trailing padding;
- continuation prefixes added to wrapped lists, quotes, and diffs; and
- style spans split independently from Unicode grapheme boundaries.

Trimming or copying `plain_text()` would either copy visual paint padding or
delete intentional source whitespace. The selection implementation must carry
copy provenance out of the wrapping algorithm.

### 9.2 Target wrapped-row model

Replace the cache's bare `Vec<LogLine>` projection with an equivalent
provenance-bearing row type:

```rust
enum LogicalBreakAfter {
    SoftWrap,
    HardBreak,
    End,
}

struct WrappedLogRow {
    rendered: LogLine,
    selectable_fragments: Vec<SelectableFragment>,
    break_after: LogicalBreakAfter,
}

struct SelectableFragment {
    cell_start: usize,
    cell_end: usize, // exclusive terminal-cell range
    text: String,   // visible sanitized grapheme text represented by the range
}
```

Rules:

- Every source grapheme produces at most one selectable fragment.
- Both cells of a width-two grapheme map to the same whole grapheme; selection
  never copies half a grapheme.
- Zero-width combining marks remain attached to their grapheme cluster.
- Synthetic padding and continuation prefixes have no selectable fragment.
- Intentional source spaces retain fragments, including leading spaces.
- Style/ANSI state remains only in `rendered` and never enters copied text.
- `SoftWrap` means no newline is inserted when a selection crosses to the next
  wrapped row from the same logical source line.
- `HardBreak` inserts one newline when the selection crosses the boundary.
- Empty logical log lines preserve hard breaks.
- `End` adds no trailing newline merely because the selection ends at the final
  row.

The wrapping helpers should emit render output and provenance together. Do not
attempt to reverse-engineer synthetic prefixes after rendering.

### 9.3 Copy reconstruction

Given a normalized inclusive cell range:

1. intersect each covered wrapped row with its selectable fragments;
2. append each intersecting grapheme once, in visual order;
3. between covered rows, append nothing for `SoftWrap` and `\n` for
   `HardBreak`;
4. exclude trailing painted cells and non-selectable gutters; and
5. enforce the payload limit before writing.

Copy uses the visible, sanitized transcript projection. It does not recover raw
Markdown that the UI intentionally simplified and does not expose hidden log
payloads.

### 9.4 Cell hit testing

- A cell inside a selectable fragment resolves to that fragment's whole
  grapheme.
- A cell in synthetic left/right padding clamps to the nearest selectable
  boundary on the same row.
- Primary down on a row with no selectable fragments does not start a
  selection.
- During a drag, crossing a non-selectable blank row is allowed; the focus
  resolves to the nearest selectable row in the drag direction while the blank
  row's hard-break contribution remains part of a spanning selection.
- Coordinates beyond the rendered row width clamp to the last selectable
  boundary; they never synthesize spaces for copying.

---

## 10. Highlight rendering

Highlighting belongs in the view projection and must not mutate cached
`LogLine` or `WrappedLogRow` values.

For each visible row, the view intersects the current normalized selection with
selectable fragments and applies a selection style to the corresponding spans.
The implemented style uses an explicit high-contrast foreground/background
pair. It clears `DIM`, `REVERSED`, and `HIDDEN` on selected cells so terminal SGR
state and pre-existing low-emphasis modifiers cannot make selected text faint.

Requirements:

- selected code/diff backgrounds remain legible;
- non-selectable padding is not highlighted;
- reverse-direction drags produce the same output as forward drags;
- a completed selection can render while the composer remains focused; and
- selection rendering adds no terminal side effects.

---

## 11. Mouse state machine

The input reducer handles these relevant crossterm events:

| State | Event | Result |
| --- | --- | --- |
| `Idle` / `Selected` | primary down in log | start `Dragging` at hit-tested point |
| `Idle` / `Selected` | modified primary down | leave owned selection unchanged; native escape remains available |
| `Idle` / `Selected` | primary down outside log | clear completed selection; otherwise no-op |
| `Dragging` | primary drag | clamp/update focus; request redraw |
| `Dragging` | modifier appears on drag/up | cancel to `Idle`; no copy |
| `Dragging` | primary up with non-empty range | transition to `Selected`; perform one copy attempt |
| `Dragging` | primary up with empty range | transition to `Idle`; no copy |
| `Dragging` | resize/content-projection mismatch/modal/mouse off | cancel to `Idle`; no copy |
| `Dragging` | primary up while the frame is dirty | cancel to `Idle`, request redraw, and do not copy stale coordinates |
| any | scroll wheel without active drag | preserve existing transcript scroll behavior |
| `Selected` | `Esc` not consumed elsewhere | clear to `Idle` |

Pure transition and hit-test helpers remain under `app/state`. The event-loop
handler applies those transitions, performs the clipboard write only after a
successful non-empty release, and records the transient notice; view code never
writes the clipboard.

### 11.1 Drag auto-scroll

Auto-scroll is target behavior but a separate implementation phase:

- dragging at or above the log area's top edge scrolls upward;
- dragging at or below the bottom edge scrolls downward;
- the focus point updates after each scroll step;
- scrolling stops on release, cancellation, or pointer re-entry;
- the cadence is bounded and reuses the event-loop tick rather than spawning an
  unowned thread; and
- no auto-scroll occurs when the transcript cannot move further.

The first milestone may restrict selection to the visible viewport, but it must
use a state shape that does not prevent this phase.

---

## 12. Clipboard contract

Text clipboard writing extends the existing clipboard adapter under
`crates/tui/src/app/util/clipboard/`.

```rust
enum ClipboardWriteOutcome {
    Confirmed(ClipboardBackend),
    Requested(ClipboardBackend),
}

enum ClipboardBackend {
    Native,
    WindowsBridge,
    Osc52,
}
```

### 12.1 Backend order

- Native Windows/macOS/Linux: try `arboard` first.
- WSL: prefer the Windows clipboard bridge, then try native `arboard` if the
  bridge is unavailable.
- If confirmed backends fail and the payload is below the OSC 52 limit, request
  an OSC 52 copy through the terminal adapter.
- If all paths fail, retain the selected highlight and show a short failure.

Phase 1 implements the confirmed native and Windows-bridge paths. OSC 52 remains
the phase 2 fallback and is not currently attempted.

### 12.2 WSL bridge safety

The WSL bridge invokes `powershell.exe` with a fixed script and sends selected
text through stdin. Selected text must never be interpolated into the command
line or PowerShell source.

Equivalent fixed behavior:

```powershell
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
```

Rust writes UTF-8 bytes to the child stdin. The fixed script sets
`Console.InputEncoding` before `ReadToEnd()` so Windows PowerShell does not
decode CJK or emoji through the active legacy code page. The subprocess is
non-interactive, has one bounded deadline covering asynchronous stdin delivery
and process completion, and reports non-zero exit status without printing
selected text in diagnostics. A child that stops reading cannot block the TUI
indefinitely while the parent fills the pipe.

Reference behavior inspected in OpenCode's fixed revision:
[`clipboard.ts#L79-L91`](https://github.com/anomalyco/opencode/blob/a0f8dccbfe139ffc7137d1eaf6fee6e4195af599/packages/tui/src/clipboard.ts#L79-L91).

### 12.3 Limits and privacy

- Maximum copied UTF-8 payload: 1 MiB.
- Maximum OSC 52 payload: 100 KiB before base64 encoding.
- Oversized selection fails visibly; it is not truncated silently.
- Clipboard writes occur only after an explicit non-empty user drag release.
- Copied text is not logged, persisted, sent to runtime/core, or sent to a
  network service.
- Errors redact selected text and command stdin.

---

## 13. Invalidation and concurrent updates

Selection is projection-bound. Correctness takes priority over keeping a stale
highlight during mutation.

The implementation clears or cancels selection when any of these change:

- `log_version` for the selected projection;
- wrap width;
- terminal size;
- terminal mode;
- mouse capture becomes disabled;
- log reset/session switch;
- modal/panel ownership changes the selectable layout; or
- the wrapped cache for the projection is replaced.

The first implementation therefore may cancel a selection when streaming output
mutates the log. A later optimization may preserve selection by introducing
stable logical row identities, but it must not keep absolute row indexes across
a projection change without proof that they still identify the same text.

Existing scroll stability while `scroll_from_bottom > 0` remains unchanged.

---

## 14. Module ownership

The intended implementation split is:

| Responsibility | Location |
| --- | --- |
| Selection types, normalization, pure transitions | `crates/tui/src/app/state/selection.rs` |
| Provenance-bearing wrap rows and text reconstruction | `crates/tui/src/app/log_wrap.rs` or a focused child module |
| Frame hit map and selection highlighting | `crates/tui/src/app/view/ui/` |
| Raw mouse-to-semantic routing | `crates/tui/src/event_loop/input.rs` |
| Native/WSL text clipboard adapter | `crates/tui/src/app/util/clipboard/` |
| OSC 52 terminal write | `crates/tui/src/entry/terminal.rs` or a terminal-side effect adapter |
| Composition and resolved-mode gating | `crates/tui/src/entry/run_loop.rs` |

Boundary rules:

- `state` does not import `view`, `render`, `handlers`, terminal IO, or clipboard
  libraries.
- `view` may read selection state but does not write the clipboard.
- `event_loop` routes effects but does not recreate wrapping/layout logic.
- Clipboard adapters do not mutate `AppState`.
- Inline scrollback insertion remains isolated in `app/render/inline.rs`.

---

## 15. Implementation phases

### Phase 1: visible transcript selection

Implemented 2026-08-17.

Automated coverage is complete; the primary Windows Terminal/WSL manual matrix
still requires validation on that host stack.

- Add state model and full `MouseEvent` routing.
- Publish current transcript hit geometry.
- Add provenance-bearing wrapped rows.
- Support primary down/drag/up within the visible log viewport.
- Render selection highlight.
- Copy on release through native/WSL clipboard backends.
- Preserve wheel scrolling and bracketed paste.
- Cancel safely on stale projection/resize/mutation.

### Phase 2: terminal fallback and long-range drag

Not implemented.

- Add bounded OSC 52 fallback with truthful `Requested` feedback.
- Add tick-driven drag auto-scroll.
- Validate tmux/Zellij passthrough behavior without adding terminal-brand policy
  to `auto` mode.

### Phase 3: selection affordances

- Double-click word and triple-click logical-line selection.
- Optional right-click paste on Windows/WSL, inserting clipboard text into the
  active composer without submission.
- Optional keyboard copy mode or `/copy` command.
- Optional persisted mouse-selection configuration if `F2` proves insufficient.

Each phase must update this document's status/current-behavior section rather
than describing planned behavior as already implemented.

---

## 16. Test contract

### 16.1 Pure state tests

- forward and reverse drag normalization;
- zero-width release does not copy;
- the finish transition returns a normalized range only once on release;
- highlight-only redraw advances `frame_revision` without invalidating the
  selection projection or cancelling the next drag event;
- a new hit-map geometry with the same selection projection continues the drag
  using the latest `log_area` and visible range;
- primary down rejects a row without selectable fragments;
- horizontal synthetic padding/gutters clamp to the nearest selectable cell;
- a blank row crossed during an active drag resolves to the next selectable row
  in anchor-relative drag direction;
- stale projection, resize, modal, and mouse-off cancellation;
- completed selection clear/restart behavior.

### 16.2 Wrap/projection tests

- ASCII partial-row and multi-row extraction;
- soft wrap rejoins without newline;
- hard breaks and blank lines are preserved;
- user bubble padding is not copied;
- code/diff painted padding is not copied;
- permission diff line-number and `+`/`-`/context gutters are not copied;
- synthetic continuation indent is not copied;
- intentional leading/trailing source spaces are selectable;
- multi-span styled rows reconstruct the same visible text;
- CJK width-two characters, emoji, combining marks, and zero-width joiner
  sequences are copied as whole graphemes;
- combining and ZWJ graphemes remain on one wrapped row even when their code
  points cross style-span or wrap boundaries;
- selecting either cell of a width-two grapheme includes it once.

### 16.3 View tests

- `TestBackend` shows the selected cells with the selection style;
- selection styling uses explicit colors without `DIM`, `REVERSED`, or `HIDDEN`,
  and clearing selection restores the original cell style;
- non-selected styles remain unchanged;
- reverse selection renders identically;
- non-selectable padding is not highlighted;
- hit-map geometry matches the rendered log rectangle;
- copy feedback is visible in both info and help status modes.

### 16.4 Event tests

- unmodified drag in alternate/mouse-on selects and copies;
- mouse-off and inline mode do not enter owned selection;
- wheel scrolling still updates `scroll_from_bottom`;
- bracketed `Event::Paste` still inserts multiline text;
- stale dirty-frame mouse down is ignored;
- primary down with `Shift`, `Alt`, or `Control` does not start owned selection,
  and modifiers appearing during an owned drag cancel without copying;
- dirty-frame mouse up cancels the drag and requests redraw instead of leaving
  `Dragging` stuck or copying stale coordinates;
- clearing an already-idle selection preserves the current hit map so the next
  mouse down can start immediately;
- drag -> highlight redraw -> drag continues when the content projection is
  unchanged, even though `frame_revision` advanced;
- selection does not bypass modal input ownership;
- clearing an idle selection with an active copy notice requests redraw while
  preserving the current hit map.

### 16.5 Clipboard tests

- backend selection from pure environment facts;
- UTF-8 text is piped through stdin, never command arguments;
- the fixed PowerShell script sets `Console.InputEncoding` to UTF-8 before
  `ReadToEnd()`;
- CJK and emoji round-trip through the Windows bridge without replacement or
  code-page corruption;
- WSL bridge status/timeout/failure classification;
- the same timeout bounds pipe delivery when a child does not read stdin;
- payload and OSC 52 limits;
- diagnostics do not contain selected text.

### 16.6 Manual acceptance matrix

- Windows Terminal -> WSL -> `--tui-mode alternate`;
- native Windows Terminal when a Windows TUI build is available;
- macOS Terminal/iTerm2/Ghostty explicit alternate mode;
- Linux terminal explicit alternate mode;
- Windows Terminal -> WSL -> tmux (phase 2).

For the primary WSL case, verify in one run:

1. wheel scroll still navigates Codelia history;
2. ordinary drag visibly selects transcript text;
3. interim highlight redraws during a multi-event drag do not cancel it;
4. release copies exact text to the Windows clipboard;
5. `Ctrl+Shift+V` pastes it into the composer without auto-submit;
6. CJK/emoji and a soft-wrapped code/text sample round-trip correctly;
7. resize or streaming invalidation never copies a mismatched range; and
8. exit restores mouse, bracketed-paste, raw-mode, cursor, and alternate-screen
   terminal state.

---

## 17. Acceptance criteria

The first implementation is complete when:

- ordinary primary drag works in alternate mode on Windows Terminal/WSL without
  requiring `Shift` or `F2`;
- copied text excludes synthetic visual padding and ANSI/style data;
- Unicode grapheme and soft/hard line-break tests pass;
- wheel scrolling and bracketed paste remain functional;
- per-draw `frame_revision` changes do not invalidate an otherwise unchanged
  selection projection;
- stale projection changes cancel instead of copying the wrong text;
- WSL writes confirmed UTF-8 text to the Windows clipboard without command-line
  interpolation or legacy-code-page decoding;
- failures are bounded, non-fatal, and do not expose copied text;
- inline mode behavior and render-state invariants remain unchanged; and
- the TUI test suite, formatting, Clippy, workspace checks, and the manual WSL
  smoke pass for the final tree.

---

## 18. Deferred decisions

- Whether a completed highlight should clear automatically after a timeout.
- Whether copy-on-release should become configurable independently of mouse
  capture.
- Whether stable logical row IDs justify preserving selection across streaming
  log updates.
- Whether right-click paste should be Windows/WSL-only or a cross-platform TUI
  gesture.
- Whether a generic transient-notice facility should replace a selection-local
  copy notice.
