# render layer

`src/app/render/` applies terminal-facing side effects after frame draw.

## Scope

- `inline.rs`: scrollback synchronization and cursor-phase side effects.
- `insert_history/`: terminal history insertion primitive.
- `custom_terminal/`: terminal abstraction for inline viewport control.

## Rules

- Keep policy aligned with:
  - `docs/specs/tui-render-state-machine.md`
  - `docs/specs/tui-terminal-mode.md`
- Side-effect path may update only render-sync related state.
- Do not move UI composition logic into this layer.

## Key Behavior

- Scrollback insertion range is based on render state boundary (`[inserted_until, visible_start)`).
- Follow-up redraw is required after scrollback insertion (`InsertedNeedsRedraw` path).

