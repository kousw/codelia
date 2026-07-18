# render layer

`src/app/render/` applies terminal-facing side effects after frame draw.

## Scope

- `inline.rs`: render-state synchronization and scrollback insertion through Ratatui's `Terminal::insert_before` API.

## Rules

- Keep policy aligned with:
  - `dev-docs/specs/tui-render-state-machine.md`
  - `dev-docs/specs/tui-terminal-mode.md`
- Side-effect path may update only render-sync related state.
- Do not move UI composition logic into this layer.
- Ratatui owns viewport, cursor, buffer, and scrolling-region bookkeeping. Do not add direct backend writes in the event-loop side-effect path.

## Key Behavior

- Scrollback insertion range is based on render state boundary (`[inserted_until, visible_start)`).
- Advance `inserted_until` only after the corresponding `insert_before` call succeeds.
- Follow-up redraw is required after scrollback insertion (`InsertedNeedsRedraw` path).
