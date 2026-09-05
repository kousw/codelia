# Runtime parser

`parser.rs` owns protocol dispatch and parser-level regression tests. Keep event ordering and `ParsedOutput` behavior stable while refactoring rendering internals.

## Dependency direction

- `types.rs` owns parser output DTOs.
- `common.rs` owns small pure presentation primitives shared by multiple renderers.
- `helpers.rs` owns general protocol formatting and the single tool-result dispatcher.
- `diff.rs` owns unified-diff parsing, syntax-highlighted diff rendering, permission previews, and normalized diff fingerprints.
- `web.rs` owns `web_search` / `webfetch` call and result summaries.
- Domain renderers such as `todo.rs`, `lane.rs`, `agents.rs`, and `shell.rs` may depend on `common.rs` and `app::state` presentation types.
- `subagents.rs` formats task_* calls/results using agent name, child state, assignment and bounded summary/failure detail. Do not dump lineage/permission JSON. A successful task_wait transport still shows failure when the child state is failed; keep pending-header replacement consistent with that state.
- Message send/receive and the exact runtime `hidden_user_message` peer envelope
  show authenticated display names and bounded content, not raw message JSON or
  a user-input prefix. Sent means stored, not read; incoming messages remain
  coordination only. Other hidden-user content keeps its existing fallback.
- Domain renderers must not depend on `handlers`, `view`, `render`, `AppState`, or runtime process/RPC adapters.
- Keep terminal side effects and application-state mutation outside parser modules; renderers return `LogLine` values and metadata only.

Prefer a domain module when a renderer has its own parsing, error classification, summary, and detail rules. Do not create a broad service locator or pass the whole `AppState` to renderers.

Keep the shell domain cohesive: tool-call summaries, tagged shell blocks, JSON task records, error classification, metadata, and bounded output previews belong in `shell.rs`. The general dispatcher should only select the renderer and preserve fallback behavior. Keep parser-level regression tests colocated in `parser.rs`; its production dispatcher ends before the `tests` module, so do not split tests solely to reduce the raw line count.
