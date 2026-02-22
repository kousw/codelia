# app module

`src/app/` is the application root for TUI runtime loop integration.

## Scope

- Own `AppState` and cross-layer orchestration helpers (`mod.rs`).
- Assemble sub-layers:
  - `state/`: persistent UI/render/domain state
  - `view/`: frame composition
  - `render/`: terminal side effects
  - `handlers/`: key-driven behavior
  - `runtime/`: RPC boundary
  - `util/`: shared helpers
- Permission preview diff parsing (runtime parser) supports syntax highlighting via fenced code language, explicit `permission.preview.language` hint, diff header extension inference, and `permission.preview.file_path` fallback when headers are missing.
- `permission.preview` / `permission.ready` may include `tool_call_id`; TUI uses it to correlate preview vs `tool_result(edit)` and suppress duplicate diff bodies when the same non-truncated diff was already shown in preview.
- Permission preview diff rows style non-code prefixes with dedicated tints: line numbers are muted, `+` marker is green-tinted, `-` marker is red-tinted, markers include a trailing space (`+ ` / `- `), while code token fg comes from syntect.
- Set `CODELIA_DEBUG_DIFF_HIGHLIGHT=1` to append parser-level debug lines in permission preview (`lang`, `file`, `colored_rows/total_rows`).
- Error rendering now supports summary/detail modes via `/errors [summary|detail|show]`.
  - `summary` mode (default): concise error line with optional hint; multiline payloads stay hidden.
  - `detail` mode: appends error detail lines directly in the log.
  - `show`: prints stored detail for the latest error when available.

## Dependency Direction

- Prefer one-way flow:
  - `handlers/view/render/runtime -> state`
- `view` must not depend on `handlers`.
- Terminal side effects belong in `render`, not `view`.

## References

- `crates/tui/AGENTS.md`
- `docs/specs/tui-architecture.md`
- `docs/specs/tui-render-state-machine.md`
