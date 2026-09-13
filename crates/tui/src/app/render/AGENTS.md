# render layer

`src/app/render/` applies terminal-facing side effects after frame draw.

## Scope

- `inline.rs`: render-state synchronization and scrollback insertion through Ratatui's `Terminal::insert_before` API.
- `frame.rs`: production bounded draw/insert/restore cycle, shared with terminal replay tests.

## Rules

- Keep policy aligned with:
  - `dev-docs/specs/tui-render-state-machine.md`
  - `dev-docs/specs/tui-terminal-mode.md`
- Side-effect path may update only render-sync related state.
- Do not move UI composition logic into this layer.
- Ratatui owns viewport, cursor, buffer, and history-insertion bookkeeping. Keep its `scrolling-regions` feature disabled: CSI S does not populate native scrollback in xterm.js. Do not add direct backend writes in the event-loop side-effect path.

## Key Behavior

- Scrollback insertion range is based on render state boundary (`[inserted_until, visible_start)`).
- Advance both the source `committed` position and its projected `inserted_until` only after the corresponding `insert_before` chunk succeeds. Use the drawn cache verbatim; do not rewrap between chunks or when resuming an unchanged drawn generation.
- Stop insertion at the first row whose rendered width exceeds the viewport (including prefixes/user padding). Never commit source text clipped by `Line::render`; retry when a wider draw makes it representable.
- The LF insertion path in ratatui-core 0.1.2 sends every buffer cell to Crossterm, including wide-glyph continuation placeholders. `insert_history_chunk` changes only those placeholders to empty symbols in the disposable insertion buffer so Japanese text does not gain spaces or overflow the right edge. Preserve real spaces, source text, styles, and normal frame buffers; keep mixed-width ANSI replay coverage when changing this compatibility workaround.
- Use the same `unicode-width` version/semantics as Ratatui when wrapping and emptying continuation cells. Older width tables can mistake real following cells for placeholders; keep the U+16FF0/trailing-ASCII regression.
- Follow-up redraw is required immediately after scrollback insertion (`InsertedNeedsRedraw` path). `frame::draw_frame` performs at most one insertion pass and two draws; new overflow found during restoration stays pending for the next cycle. Never insert after the final draw and return a cleared viewport to input polling.
- Content-level regressions live in `scrollback_tests.rs`; fallible-backend chunk progress tests live in `scrollback_failure_tests.rs`. Numeric monotonicity alone does not prove content preservation across width changes.
- `frame_tests.rs` changes size during the real draw helper and asserts composer/cursor restoration and bounded work. `scrollback_ansi_tests.rs` records that helper's real Crossterm output (only terminal queries are stubbed). Its `CODELIA_TUI_CAPTURE_PATH` output is checked by `scripts/check-tui-scrollback.mjs` with headless xterm in CI: compare the full buffer, styles, composer and cursor, not filtered transcript markers. Negative controls live in `scripts/check-tui-scrollback.test.mjs`.
