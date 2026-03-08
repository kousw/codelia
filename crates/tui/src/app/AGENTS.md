# app module

`src/app/` is the application root for TUI runtime loop integration.

## Scope

- Own `AppState` and cross-layer orchestration helpers (`app_state/`).
- Own cross-layer shared presentation primitives (`theme.rs`, `markdown/*`).
- Own shared log wrapping/projection (`log_wrap.rs`) used by both `view` and `render`.
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
- `tool_result` rendering has tool-specific compaction for `todo_read` and todo mutation tools so planning output stays scannable in inline logs.
  - `todo_new` / `todo_append` / `todo_patch` / `todo_clear` and `todo_read` all surface task-list rows (`1. [ ] ...`) and `Next:` when the payload includes plan lines.
  - `note:` detail lines are suppressed from user-facing rows.
  - Raw JSON todo payloads are suppressed from user-facing rows.
  - `shell` / `shell_status` / `shell_logs` / `shell_wait` / `shell_result` / `shell_cancel` render compact summaries; `shell_logs` keeps plain log bodies, while regular shell execution/status/result rows use dedicated `LogKind::Shell` styling (muted summary + dim detail) with bash-like truncated previews instead of full metadata/output dumps. Synchronous shell previews keep at most 10 visible lines using a head/tail omission style.
  - Completed TODO rows are muted+dim only (no strikethrough) to avoid visual noise.
- `tool_call` rendering compacts todo args into concise `TODO:` labels (`TODO: Read plan`, `TODO: Set N task(s)`, `TODO: Patch N task(s)`) instead of showing raw JSON args.
- `agents_resolve` tool rendering is compacted in parser:
  - tool call shows target path summary (`AgentsResolve: <path>`)
  - tool result shows changed file count + per-file reason, without raw JSON metadata (`mtime_ms`, `size_bytes`).
- Set `CODELIA_DEBUG_DIFF_HIGHLIGHT=1` to append parser-level debug lines in permission preview (`lang`, `file`, `colored_rows/total_rows`).
- Error rendering now supports summary/detail modes via `/errors [summary|detail|show]`.
  - `summary` mode (default): concise error line with optional hint; multiline payloads stay hidden.
  - `detail` mode: appends error detail lines directly in the log.
  - `show`: prints stored detail for the latest error when available.
- Compaction lifecycle keeps `LogKind::Compaction` distinct from `Runtime`/`Rpc` so compaction output remains visible without debug logs.
  - `compaction_start` emits `Compaction: running`.
  - `compaction_complete` updates the active compaction component line in place to `Compaction: completed (compacted=true)` or `Compaction: skipped (compacted=false)` when possible; otherwise it falls back to appending that summary line.
  - Parser exposes explicit compaction lifecycle flags (`compaction_started` / `compaction_completed`) so app-layer updates do not rely on string matching.
  - Compaction component keys are run-scoped and sequenced (`run:<scope>:compaction#<seq>`) to avoid cross-run/cross-iteration collisions.
  - Tool lifecycle line tracking and compaction tracking share the same `pending_component_lines` map (generic component-line registration path).
  - Component tracking stores spans (`start..end`), currently populated as single-line spans for phase 1.
  - Summary spacing groups read lifecycle rows (`✔ Read: ...` + next `Read: ...`) to reduce blank lines for consecutive reads; non-read tool rows and `Error` remain separated.
  - `LogKind::Runtime` / `LogKind::Rpc` remain debug-only and are filtered when `--debug` is off.
  - Runtime parser is split into `runtime/parser.rs` (entry + tests), `runtime/parser/types.rs` (ParsedOutput/payload types), and `runtime/parser/helpers.rs` (rendering/formatting helpers). Keep phase-1 behavior in `parse_runtime_output` unchanged when refactoring internals.

## Dependency Direction

- Prefer one-way flow:
- `handlers/view/render/runtime -> state`
- `view` must not depend on `handlers`.
- Terminal side effects belong in `render`, not `view`.
- Keep `mod.rs` as a thin module boundary/re-export layer; put concrete app-state logic in `app_state/`.
- `AppState` runtime concerns are grouped under `rpc_pending` (request-id waits) and `runtime_info` (session/model/capabilities).
- `rpc_pending.take_match_for_response()` is the canonical RPC-id match+clear path; keep response routing order stable there.
- `handlers` and `runtime/parser` should depend on `app::theme` / `app::markdown`, not `view/*`.

## References

- `crates/tui/AGENTS.md`
- `dev-docs/specs/tui-architecture.md`
- `dev-docs/specs/tui-render-state-machine.md`
