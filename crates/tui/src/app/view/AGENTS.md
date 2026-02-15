# view layer

`src/app/view/` draws UI from current `AppState`.

## Scope

- `ui/`: Ratatui frame composition (log/input/status/panels/layout).
- `markdown/`: assistant markdown simplification for terminal rendering.
  - Fenced code blocks use `syntect` token foregrounds when available.
  - Keep code-block background decisions in `ui/style.rs`; markdown emits semantic spans only.

## Rules

- View should be presentation-only.
- No terminal side effects here (scroll-region writes, cursor hide/show, viewport mutation).
- For shared pure logic, depend on `state/*` or `util/*`.
- Do not depend on `handlers/*`.

## Handoff

- Terminal mutations are handled by `src/app/render/*`.

