# view layer

`src/app/view/` draws UI from current `AppState`.

## Scope

- `ui/`: Ratatui frame composition (log/input/status/panels/layout).
- `markdown/`: assistant markdown simplification for terminal rendering.
  - Fenced code blocks use `syntect` token foregrounds when available.
  - Default `syntect` theme is `Solarized (dark)` (fallback: first bundled theme).
  - Keep code-block background decisions in `ui/style.rs`; markdown emits semantic spans only.
  - For TypeScript labels (`ts` / `typescript`), syntax resolution may fall back to JavaScript syntax when TypeScript syntax is unavailable in the bundled syntect set.
  - For permission preview diffs in fenced code, row background comes from diff kind (`DiffAdded`/`DiffRemoved`) while syntax highlight only overrides token foreground.
  - Assistant inline markdown now colors headings (`#`), bold (`**`), and inline code (`` ` ``) via semantic spans.
  - Theme selection is centralized in `src/app/view/theme.rs`.
  - `CODELIA_TUI_THEME` controls TUI theme selection (`codelia`/`amber` default, `ocean`, `forest`, `rose`, `sakura`, `mauve`, `plum`, `iris`, `crimson`, `wine`).
- At startup, TUI also applies `initialize.result.tui.theme` from runtime (resolved config), which overrides env/default when present.
  - Multi-span wrapping must ignore empty leading spans (`""`), otherwise it can collapse to plain-text fallback and drop token-level `fg` colors.
  - Continuation indent wrapping (list/ordered/quote/leading-space contexts) is generated from `util/text` helpers and applied in both `ui/log.rs` and composer `ui/input.rs`; insertion path parity is achieved by reusing the same wrapped log cache.

## Rules

- View should be presentation-only.
- No terminal side effects here (scroll-region writes, cursor hide/show, viewport mutation).
- For shared pure logic, depend on `state/*` or `util/*`.
- Do not depend on `handlers/*`.

## Handoff

- Terminal mutations are handled by `src/app/render/*`.
