# TUI Inline Scrollback Validation

Status: `Implemented`

This document defines the validation boundary for Codelia's Ratatui inline
viewport and terminal scrollback behavior.

## 1. Ownership boundary

- Ratatui owns inline viewport layout, buffer synchronization, cursor tracking,
  and LF-based terminal history insertion. Its `scrolling-regions` feature stays
  disabled: CSI S does not retain removed rows in xterm.js native scrollback.
- Codelia tracks committed source positions (logical line and grapheme offset),
  projects them into the current wrapped `inserted_until` boundary, and
  passes pending wrapped rows to `Terminal::insert_before`.
- Codelia advances committed progress only after insertion succeeds and requests a
  follow-up draw in the same tick so the cleared viewport and composer cursor
  are restored before the next input poll.
- `render/frame.rs::draw_frame` performs at most one insertion pass and two draws.
  If the restoring draw discovers new overflow, it leaves that insertion pending
  for the next cycle rather than clearing the viewport again before polling.
- Rows wider than the insertion viewport are not committed. Insertion stops at
  the first such row, including prefixes/user padding, and retries after widening.

Codelia tests the semantic contract at its API boundary, plus a targeted real-ANSI
replay for native-history retention. TestBackend's scroll-region behavior differs
from xterm.js here, so semantic backend tests alone are insufficient.

## 2. Always-on tests

Focused tests use Ratatui `TestBackend` and run in the normal Rust test suite.
They verify that:

- empty insertion is a no-op;
- history rows enter scrollback when an inline viewport fills the entire terminal;
- the existing viewport is restored by the required follow-up draw after insertion;
- width changes preserve the pending tail and insert no unchanged source content twice;
- partial-line boundaries survive repeated rewraps and Unicode graphemes;
- historical growth/shrink cannot skip pending lines, including partial-line revisions;
- blank rows, clear/reset, scrollback pause/resume, alternate draws, and layout-only growth preserve source progress;
- layout growth during an insertion's follow-up draw keeps newly hidden content pending;
- the production frame helper restores composer text and cursor before returning,
  even if a backend size query resizes the terminal during the restoring draw;
- repeated resize requests cannot create an unbounded draw/insert loop;
- narrow/clipped Japanese and user-bubble rows retain their source progress until widening;
- Unicode-width divergence fixtures preserve real trailing ASCII cells;
- 65,536 wrapped rows do not overflow the displayed/desired height;
- skipped tiny-viewport layouts defer Codelia insertion until a valid drawn cache exists.

The implementation additionally updates the render-state boundary after each
successful insertion chunk. A fallible TestBackend wrapper verifies errors before
the first scroll of a chunk, retaining only prior successful chunks, and resuming
the same drawn generation without replaying those chunks. A long logical-line
case also retries a partially committed anchor directly, after redraw, and after
rewrap to a narrower width. This does not promise
atomicity when terminal I/O fails after part of a chunk has already been written;
the production run loop propagates such errors rather than automatically retrying.

Content regressions live in `src/app/render/scrollback_tests.rs`, with error-path
coverage in `scrollback_failure_tests.rs` and production-cycle tests in
`frame_tests.rs`. TestBackend does not emulate a terminal's
native reflow on resize, so tests distinguish its resize effects from Codelia's
new history insertion.

Run:

```bash
cargo test --manifest-path crates/tui/Cargo.toml
```

The full repository entrypoint is:

```bash
bun run test:tui
```

## 3. Headless native-scrollback smoke

`src/app/render/scrollback_ansi_tests.rs` records real Crossterm output from
the production `draw_frame` helper; only size/cursor queries are stubbed. The
always-on test guards against emitting CSI S and printing nonempty wide-glyph
continuation cells. The replay compares the complete emulator buffer against
the transcript, shell prefix, and declarative footer/padding expectations; it
does not filter out unrecognized lines. It also checks native history, active
normal buffer, code colors across wide glyphs, a nonempty composer, and final
cursor position/visibility. Visibility is observed through public parser hooks
that return false so they do not replace the emulator's processing.

Run from the repo root (npm dependencies stay outside the workspace):

```bash
probe_dir="$(mktemp -d)"
npm install --prefix "$probe_dir" --ignore-scripts --no-audit --no-fund \
  --package-lock=false @xterm/headless@6.0.0
CODELIA_TUI_CAPTURE_PATH="$probe_dir/capture.json" \
  cargo test --locked --manifest-path crates/tui/Cargo.toml inline_native_scrollback_ansi_capture
node scripts/check-tui-scrollback.mjs "$probe_dir/capture.json" "$probe_dir"
CODELIA_TUI_CAPTURE_PATH="$probe_dir/capture.json" \
  CODELIA_TUI_EMULATOR_DIR="$probe_dir" \
  node --test scripts/check-tui-scrollback.test.mjs
```

The root CI TUI job runs the capture and Node tests with pinned headless xterm,
installed outside the workspace. Rust tests still require no npm dependency.
Node tests include negative controls for leaked UI/blank rows, missing composer,
hidden/misplaced cursor, alternate-buffer switching, and lost code colors.

The fixture covers 40x12 and 40x24 terminals with a 12-row inline viewport. In the
2026-09-13 regression, the scrolling-regions output retained only 3 of 82 tracked
lines at 40x12; LF-based output retained all 82 in both sizes. This reproduces a
real emulator compatibility class, not a private ANSI golden snapshot.

The fixture now includes Japanese/ASCII mixtures, intentional spaces, combining
characters, and a wide glyph ending exactly at column 40. It exercises bulk
history (80 lines), batches of 30, and single-line updates at both heights.
The initial ASCII-only replay missed LF insertion printing wide-glyph placeholder
spaces: the mixed-width replay retained only 45/82 exact lines before the fix.
`insert_history_chunk` now empties only continuation symbols in its disposable
insertion buffer; normal frame buffers and log source text are unchanged. All
six mixed-width replay cases retain 82/82 exact lines after normalization.

Keep Codelia's `unicode-width` dependency aligned with Ratatui (currently 0.2.2).
Using 0.1.14 for continuation detection could erase following real cells: the
`U+65E5 U+16FF0 ABC` regression lost `AB`. Rendered-cell tests cover this sequence,
U+2630, and U+1FAE9. Emulator width tables are a separate compatibility boundary:
the pinned xterm engine treats U+16FF0 differently from Ratatui, including with
its Unicode-15 addon. The replay therefore covers its supported common CJK and
combining sequences, while the newer-width regressions use rendered-cell checks.
This does not establish identical rendering for every host Unicode version.

The upstream behavior is in xterm.js 6.0.0
[`InputHandler.scrollUp`](https://github.com/xtermjs/xterm.js/blob/6.0.0/src/common/InputHandler.ts),
which removes rows from the active region instead of adding them to scrollback.
This investigation followed a Codex Desktop report, but does not establish which
terminal engine/version Codex Desktop uses or its reconnect/history limits.

## 4. Manual terminal smoke

Terminal emulators and multiplexers can interpret capabilities differently even
when the semantic backend tests pass. Run a focused manual smoke after changing
Ratatui/crossterm versions, inline viewport construction, history insertion, or
exit cursor placement.

Cover at least:

- a terminal 12 rows high or smaller;
- enough output to overflow the viewport;
- exit back to the shell with the transcript still in terminal history;
- Ghostty directly and, when relevant, tmux or zellij.
- Codex Desktop's integrated terminal: rerun `bun run tui`, generate enough output,
  and use the terminal's native scrollbar/trackpad to reach the initial banner.
  Check redraw flicker as well: LF insertion redraws the viewport instead of
  preserving it through scroll-region operations.

## 5. Out of scope

- private ANSI golden snapshots beyond the known CSI S portability guard;
- a full PTY golden capture across terminal emulators;
- multiplexer-specific compatibility guarantees.

The targeted headless replay covers native-history loss, but is not a full PTY
or desktop-host integration test. Host-level history limits, reconnect behavior,
and terminal-specific resize/reflow still require manual checks.
