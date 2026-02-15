# view layer

`src/app/view/` draws UI from current `AppState`.

## Scope

- `ui/`: Ratatui frame composition (log/input/status/panels/layout).
- `markdown/`: assistant markdown simplification for terminal rendering.
  - Fenced code blocks use `syntect` token foregrounds when available.
  - Default `syntect` theme is `base16-eighties.dark` (fallback: first bundled theme).
  - Keep code-block background decisions in `ui/style.rs`; markdown emits semantic spans only.
  - For TypeScript labels (`ts` / `typescript`), syntax resolution may fall back to JavaScript syntax when TypeScript syntax is unavailable in the bundled syntect set.
  - For permission preview diffs in fenced code, row background comes from diff kind (`DiffAdded`/`DiffRemoved`) while syntax highlight only overrides token foreground.
  - Multi-span wrapping must ignore empty leading spans (`""`), otherwise it can collapse to plain-text fallback and drop token-level `fg` colors.

## Rules

- View should be presentation-only.
- No terminal side effects here (scroll-region writes, cursor hide/show, viewport mutation).
- For shared pure logic, depend on `state/*` or `util/*`.
- Do not depend on `handlers/*`.

## Handoff

- Terminal mutations are handled by `src/app/render/*`.
